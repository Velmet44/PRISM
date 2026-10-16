export const ENDPOINTS = {
  wsTickets: "/v1/ws/tickets",
  nodeIdentity: "/v1/node/identity",
  nodeVerify: "/v1/node/verify",
  nodeCapabilities: "/v1/node/capabilities",
  nmChallenges: "/nm/challenges",
} as const;

export type EndpointName = keyof typeof ENDPOINTS;
