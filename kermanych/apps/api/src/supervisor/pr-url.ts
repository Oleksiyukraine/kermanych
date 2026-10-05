// apps/api/src/supervisor/pr-url.ts
// A pull-request URL — the signal that a «Створити ПР» flow actually opened one: GitHub
// `/pull/N`, GitLab `/-/merge_requests/N`, Bitbucket `/pull-requests/N`. Non-global so
// `.test` stays stateless across the many messages one turn streams. Shared by the managed
// event stream (supervisor.service.ts) and the native session-file reader
// (native/native-session.service.ts).
export const PR_URL_RE = /https?:\/\/\S+\/(?:pull|pull-requests|merge_requests)\/\d+/i;
