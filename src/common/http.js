// @ts-check

import axios from "axios";

// Keep well below the 10-15s function limit so a hung connection errors
// into the stale-cache fallback instead of killing the function.
const REQUEST_TIMEOUT_MS = 7000;

/**
 * Send GraphQL request to GitHub API.
 *
 * @param {import('axios').AxiosRequestConfig['data']} data Request data.
 * @param {import('axios').AxiosRequestConfig['headers']} headers Request headers.
 * @returns {Promise<any>} Request response.
 */
const request = (data, headers) => {
  return axios({
    url: "https://api.github.com/graphql",
    method: "post",
    headers,
    data,
    timeout: REQUEST_TIMEOUT_MS,
  });
};

export { request };
