// @ts-check

import axios from "axios";
import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { calculateRank } from "../calculateRank.js";
import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { CustomError, MissingParamError } from "../common/error.js";
import { wrapTextMultiline } from "../common/fmt.js";
import { request } from "../common/http.js";
import {
  readCacheEntry,
  writeCacheEntry,
  MAX_STALE_TTL_SECONDS,
} from "../common/kv-store.js";

dotenv.config();

// GraphQL queries.
const GRAPHQL_REPOS_FIELD = `
  repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}, after: $after) {
    totalCount
    nodes {
      name
      stargazers {
        totalCount
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

const GRAPHQL_REPOS_QUERY = `
  query userInfo($login: String!, $after: String) {
    user(login: $login) {
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

// Main stats query deliberately omits repositoriesContributedTo.
// That field has high GraphQL node cost and fails with RESOURCE_LIMITS_EXCEEDED
// for high-activity accounts; fetching it separately keeps the card fast/reliable.
const GRAPHQL_STATS_QUERY = `
  query userInfo($login: String!, $after: String, $includeMergedPullRequests: Boolean!, $includeDiscussions: Boolean!, $includeDiscussionsAnswers: Boolean!, $startTime: DateTime = null) {
    user(login: $login) {
      name
      login
      commits: contributionsCollection (from: $startTime) {
        totalCommitContributions,
      }
      reviews: contributionsCollection {
        totalPullRequestReviewContributions
      }
      pullRequests(first: 1) {
        totalCount
      }
      mergedPullRequests: pullRequests(states: MERGED) @include(if: $includeMergedPullRequests) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      followers {
        totalCount
      }
      repositoryDiscussions @include(if: $includeDiscussions) {
        totalCount
      }
      repositoryDiscussionComments(onlyAnswers: true) @include(if: $includeDiscussionsAnswers) {
        totalCount
      }
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

// Canonical "Contributed to" count (unique repos). Isolated so failures never
// take down the main stats query.
const GRAPHQL_CONTRIBUTED_TO_QUERY = `
  query contributedToCount($login: String!) {
    user(login: $login) {
      repositoriesContributedTo(
        first: 1
        contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
      ) {
        totalCount
      }
    }
  }
`;

// Cheaper fallback when the canonical field is rejected. Year-scoped and
// commit-only — not identical semantics, but better than blanking the metric.
const GRAPHQL_CONTRIBUTED_TO_FALLBACK_QUERY = `
  query contributedToFallback($login: String!) {
    user(login: $login) {
      contributionsCollection {
        totalRepositoriesWithContributedCommits
      }
    }
  }
`;

/** @type {Map<string, { value: number, exact: boolean, expiresAt: number }>} */
const contributedToCache = new Map();

const DEFAULT_CONTRIBUTED_TO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Fresh TTLs for the persistent stats cache. Past years are immutable, so a
// 30-day retention is safe; the current year is still accruing, so refresh it
// every 6 hours while stale entries stay servable for a full day.
const FRESH_TTL_CURRENT_YEAR_SECONDS = 6 * 60 * 60;
const FRESH_TTL_PAST_YEAR_SECONDS = MAX_STALE_TTL_SECONDS;
const STALE_SERVE_SECONDS = 24 * 60 * 60;

const getYear = () => new Date().getUTCFullYear();

/**
 * Cache key covering every input that changes the computed stats, so two
 * requests with different render inputs never share an entry.
 *
 * @param {string} username GitHub username.
 * @param {object} opts Key inputs.
 * @param {boolean} opts.includeAllCommits Whether REST total-commits is used.
 * @param {number|undefined} opts.year Commits year filter.
 * @param {boolean} opts.mergedPRs Whether merged-PR counts are included.
 * @param {boolean} opts.discussions Whether discussion counts are included.
 * @param {boolean} opts.discussionsAnswers Whether answer counts are included.
 * @param {string[]} opts.excludeRepo Repositories excluded from star totals.
 * @returns {string} Cache key.
 */
const getStatsCacheKey = (username, opts) =>
  `stats:${username.toLowerCase()}:${opts.includeAllCommits ? 1 : 0}:${
    opts.year || "all"
  }:${opts.mergedPRs ? 1 : 0}:${opts.discussions ? 1 : 0}:${
    opts.discussionsAnswers ? 1 : 0
  }:${[...new Set(opts.excludeRepo)].sort().join(".")}`;

/**
 * @returns {number} Cache TTL in ms for contributed-to counts.
 */
const getContributedToCacheTtlMs = () => {
  const fromEnv = parseInt(process.env.CONTRIBUTED_TO_CACHE_TTL_MS || "", 10);
  if (!isNaN(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_CONTRIBUTED_TO_CACHE_TTL_MS;
};

/**
 * Clear contributed-to cache (tests).
 */
const clearContributedToCache = () => {
  contributedToCache.clear();
};

/**
 * @param {string} username GitHub username.
 * @returns {{ value: number, exact: boolean } | null} Cached entry or null.
 */
const readContributedToCache = (username) => {
  const key = username.toLowerCase();
  const hit = contributedToCache.get(key);
  if (!hit) {
    return null;
  }
  if (Date.now() > hit.expiresAt) {
    contributedToCache.delete(key);
    return null;
  }
  return { value: hit.value, exact: hit.exact };
};

/**
 * @param {string} username GitHub username.
 * @param {number} value Contributed-to count.
 * @param {boolean} exact Whether the value is the canonical count.
 */
const writeContributedToCache = (username, value, exact) => {
  contributedToCache.set(username.toLowerCase(), {
    value,
    exact,
    expiresAt: Date.now() + getContributedToCacheTtlMs(),
  });
};

/**
 * Stats fetcher object.
 *
 * @param {object & { after: string | null }} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const fetcher = (variables, token) => {
  const query = variables.after ? GRAPHQL_REPOS_QUERY : GRAPHQL_STATS_QUERY;
  return request(
    {
      query,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * @param {object} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const contributedToExactFetcher = (variables, token) =>
  request(
    {
      query: GRAPHQL_CONTRIBUTED_TO_QUERY,
      variables: { login: variables.login },
    },
    { Authorization: `bearer ${token}` },
  );

/**
 * @param {object} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const contributedToFallbackFetcher = (variables, token) =>
  request(
    {
      query: GRAPHQL_CONTRIBUTED_TO_FALLBACK_QUERY,
      variables: { login: variables.login },
    },
    { Authorization: `bearer ${token}` },
  );

/**
 * Fetch unique "repositories contributed to" with cache + fallbacks.
 * Prefer exact GraphQL totalCount; on RESOURCE_LIMITS_EXCEEDED use cache then
 * year-scoped commit-repo count.
 *
 * @param {string} username GitHub username.
 * @returns {Promise<number>} Contributed-to count.
 */
const fetchContributedToCount = async (username) => {
  const cached = readContributedToCache(username);
  if (cached) {
    return cached.value;
  }

  try {
    const exactRes = await retryer(contributedToExactFetcher, {
      login: username,
    });
    const errors = exactRes.data?.errors;
    const total =
      exactRes.data?.data?.user?.repositoriesContributedTo?.totalCount;

    if (!errors && typeof total === "number") {
      writeContributedToCache(username, total, true);
      return total;
    }

    // Field-level limit or other soft failure → keep going.
    logger.log(
      `contributedTo exact query failed for ${username}: ${JSON.stringify(
        errors?.[0] || "unknown",
      )}`,
    );
  } catch (err) {
    logger.log(`contributedTo exact query threw for ${username}: ${err}`);
  }

  // Stale cache is already handled above; try cheaper fallback metric.
  try {
    const fallbackRes = await retryer(contributedToFallbackFetcher, {
      login: username,
    });
    const fallback =
      fallbackRes.data?.data?.user?.contributionsCollection
        ?.totalRepositoriesWithContributedCommits;
    if (!fallbackRes.data?.errors && typeof fallback === "number") {
      // Cache approximate value with shorter integrity flag; still useful.
      writeContributedToCache(username, fallback, false);
      return fallback;
    }
  } catch (err) {
    logger.log(`contributedTo fallback threw for ${username}: ${err}`);
  }

  return 0;
};

/**
 * Fetch stats information for a given username.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} variables.username GitHub username.
 * @param {boolean} variables.includeMergedPullRequests Include merged pull requests.
 * @param {boolean} variables.includeDiscussions Include discussions.
 * @param {boolean} variables.includeDiscussionsAnswers Include discussions answers.
 * @param {string|undefined} variables.startTime Time to start the count of total commits.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 *
 * @description This function supports multi-page fetching if the 'FETCH_MULTI_PAGE_STARS' environment variable is set to true.
 */
const statsFetcher = async ({
  username,
  includeMergedPullRequests,
  includeDiscussions,
  includeDiscussionsAnswers,
  startTime,
}) => {
  let stats;
  let hasNextPage = true;
  let endCursor = null;
  while (hasNextPage) {
    const variables = {
      login: username,
      first: 100,
      after: endCursor,
      includeMergedPullRequests,
      includeDiscussions,
      includeDiscussionsAnswers,
      startTime,
    };
    let res = await retryer(fetcher, variables);
    if (res.data.errors) {
      return res;
    }

    // Store stats data.
    const repoNodes = res.data.data.user.repositories.nodes;
    if (stats) {
      stats.data.data.user.repositories.nodes.push(...repoNodes);
    } else {
      stats = res;
    }

    // Disable multi page fetching on public Vercel instance due to rate limits.
    const repoNodesWithStars = repoNodes.filter(
      (node) => node.stargazers.totalCount !== 0,
    );
    hasNextPage =
      process.env.FETCH_MULTI_PAGE_STARS === "true" &&
      repoNodes.length === repoNodesWithStars.length &&
      res.data.data.user.repositories.pageInfo.hasNextPage;
    endCursor = res.data.data.user.repositories.pageInfo.endCursor;
  }

  return stats;
};

/**
 * Fetch total commits using the REST API.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} variables.login GitHub username.
 * @param {number|undefined} variables.year Year to filter commits (optional).
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 *
 * @see https://developer.github.com/v3/search/#search-commits
 */
const fetchTotalCommits = (variables, token) => {
  // Build search query: author:username + optional year filter
  let query = `author:${variables.login}`;
  if (variables.year) {
    query += ` committer-date:${variables.year}-01-01..${variables.year}-12-31`;
  }

  return axios({
    method: "get",
    url: `https://api.github.com/search/commits?q=${encodeURIComponent(query)}`,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github.cloak-preview",
      Authorization: `token ${token}`,
    },
    timeout: 7000,
  });
};

/**
 * Fetch all the commits for all the repositories of a given username.
 *
 * @param {string} username GitHub username.
 * @param {number|undefined} year Optional year to filter commits.
 * @returns {Promise<number>} Total commits.
 *
 * @description Done like this because the GitHub API does not provide a way to fetch all the commits. See
 * #92#issuecomment-661026467 and #211 for more information.
 */
const totalCommitsFetcher = async (username, year) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username provided.");
    throw new Error("Invalid username provided.");
  }

  let res;
  try {
    res = await retryer(fetchTotalCommits, { login: username, year });
  } catch (err) {
    logger.log(err);
    throw new Error(err);
  }

  const totalCount = res?.data?.total_count;
  if (totalCount == null || isNaN(totalCount)) {
    throw new CustomError(
      "Could not fetch total commits.",
      CustomError.GITHUB_REST_API_ERROR,
    );
  }
  return totalCount;
};

/**
 * Fetch stats for a given username.
 *
 * @param {string} username GitHub username.
 * @param {boolean} include_all_commits Include all commits.
 * @param {string[]} exclude_repo Repositories to exclude.
 * @param {boolean} include_merged_pull_requests Include merged pull requests.
 * @param {boolean} include_discussions Include discussions.
 * @param {boolean} include_discussions_answers Include discussions answers.
 * @param {number|undefined} commits_year Year to count total commits
 * @returns {Promise<import("./types").StatsData>} Stats data.
 */
const fetchStats = async (
  username,
  include_all_commits = false,
  exclude_repo = [],
  include_merged_pull_requests = false,
  include_discussions = false,
  include_discussions_answers = false,
  commits_year,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  if (include_all_commits && !githubUsernameRegex.test(username)) {
    logger.log("Invalid username provided.");
    throw new Error("Invalid username provided.");
  }

  // Warm persistent cache read. A fresh entry skips GitHub entirely — this is
  // what keeps Camo reloads and cold instances fast.
  const cacheKey = getStatsCacheKey(username, {
    includeAllCommits: include_all_commits,
    year: commits_year,
    mergedPRs: include_merged_pull_requests,
    discussions: include_discussions,
    discussionsAnswers: include_discussions_answers,
    excludeRepo: [...exclude_repo, ...excludeRepositories],
  });
  const freshTtl =
    commits_year && commits_year < getYear()
      ? FRESH_TTL_PAST_YEAR_SECONDS
      : FRESH_TTL_CURRENT_YEAR_SECONDS;

  const cached = await readCacheEntry(cacheKey);
  if (cached && cached.age < freshTtl && cached.value && cached.value.rank) {
    return cached.value;
  }

  const stats = {
    name: "",
    totalPRs: 0,
    totalPRsMerged: 0,
    mergedPRsPercentage: 0,
    totalReviews: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    totalDiscussionsStarted: 0,
    totalDiscussionsAnswered: 0,
    contributedTo: 0,
    rank: { level: "C", percentile: 100 },
  };

  let res, contributedTo, totalCommits;
  try {
    [res, contributedTo, totalCommits] = await Promise.all([
      statsFetcher({
        username,
        includeMergedPullRequests: include_merged_pull_requests,
        includeDiscussions: include_discussions,
        includeDiscussionsAnswers: include_discussions_answers,
        startTime: commits_year ? `${commits_year}-01-01T00:00:00Z` : undefined,
      }),
      fetchContributedToCount(username),
      include_all_commits
        ? totalCommitsFetcher(username, commits_year).catch((err) => {
            logger.log(`totalCommits fetch failed for ${username}: ${err}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
  } catch (err) {
    // Network/timeout failures: stale cache beats an error card.
    if (cached && cached.age < STALE_SERVE_SECONDS && cached.value?.rank) {
      logger.log(`serving stale stats for ${username} (fetch threw: ${err})`);
      return cached.value;
    }
    throw err;
  }

  // Catch GraphQL errors.
  if (res.data.errors) {
    logger.error(res.data.errors);
    if (res.data.errors[0].type === "NOT_FOUND") {
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user.",
        CustomError.USER_NOT_FOUND,
      );
    }
    if (cached && cached.age < STALE_SERVE_SECONDS && cached.value?.rank) {
      logger.log(
        `serving stale stats for ${username} (GraphQL errors: ${JSON.stringify(
          res.data.errors[0],
        )})`,
      );
      return cached.value;
    }
    if (res.data.errors[0].message) {
      throw new CustomError(
        wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
        res.statusText,
      );
    }
    throw new CustomError(
      "Something went wrong while trying to retrieve the stats data using the GraphQL API.",
      CustomError.GRAPHQL_ERROR,
    );
  }

  const user = res.data.data.user;

  stats.name = user.name || user.login;

  if (include_all_commits) {
    if (totalCommits === null) {
      // Upstream failed: serve stale cache when available, otherwise error card.
      if (cached && cached.age < STALE_SERVE_SECONDS && cached.value?.rank) {
        logger.log(`serving stale stats for ${username} (commits fetch failed)`);
        return cached.value;
      }
      throw new CustomError(
        "Could not fetch total commits.",
        CustomError.GITHUB_REST_API_ERROR,
      );
    }
    stats.totalCommits = totalCommits;
  } else {
    // Use GraphQL contributions (personal repos only, but respects time range)
    stats.totalCommits = user.commits.totalCommitContributions;
  }
  stats.contributedTo = contributedTo;

  stats.totalPRs = user.pullRequests.totalCount;
  if (include_merged_pull_requests) {
    stats.totalPRsMerged = user.mergedPullRequests.totalCount;
    stats.mergedPRsPercentage =
      (user.mergedPullRequests.totalCount / user.pullRequests.totalCount) *
        100 || 0;
  }
  stats.totalReviews = user.reviews.totalPullRequestReviewContributions;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;
  if (include_discussions) {
    stats.totalDiscussionsStarted = user.repositoryDiscussions.totalCount;
  }
  if (include_discussions_answers) {
    stats.totalDiscussionsAnswered =
      user.repositoryDiscussionComments.totalCount;
  }

  // Retrieve stars while filtering out repositories to be hidden.
  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];
  let repoToHide = new Set(allExcludedRepos);

  stats.totalStars = user.repositories.nodes
    .filter((data) => {
      return !repoToHide.has(data.name);
    })
    .reduce((prev, curr) => {
      return prev + curr.stargazers.totalCount;
    }, 0);

  stats.rank = calculateRank({
    all_commits: include_all_commits,
    commits: stats.totalCommits,
    prs: stats.totalPRs,
    reviews: stats.totalReviews,
    issues: stats.totalIssues,
    repos: user.repositories.totalCount,
    stars: stats.totalStars,
    followers: user.followers.totalCount,
  });

  await writeCacheEntry(cacheKey, stats);

  return stats;
};

export { fetchStats, clearContributedToCache };
export default fetchStats;
