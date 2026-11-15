// Stable demo IDs shared by every member, the seed, and the F4 fixtures.
// Never change these once committed: other branches hard-code them.

export const USERS = {
  maya: '10000000-0000-4000-8000-000000000001',
  sam: '10000000-0000-4000-8000-000000000002',
  priya: '10000000-0000-4000-8000-000000000003',
  alex: '10000000-0000-4000-8000-000000000004',
};

export const ACCOUNTS = {
  maya: '20000000-0000-4000-8000-000000000001',
  sam: '20000000-0000-4000-8000-000000000002',
  priya: '20000000-0000-4000-8000-000000000003',
  alex: '20000000-0000-4000-8000-000000000004',
};

export const GROUPS = {
  puffton4: '30000000-0000-4000-8000-000000000001',
  bostonWeekend: '30000000-0000-4000-8000-000000000002',
};

export const BILLS = {
  rent: '40000000-0000-4000-8000-000000000001',
  utilities: '40000000-0000-4000-8000-000000000002',
  spotify: '40000000-0000-4000-8000-000000000003',
  cloudStorage: '40000000-0000-4000-8000-000000000004',
  campusGym: '40000000-0000-4000-8000-000000000005',
  phonePlan: '40000000-0000-4000-8000-000000000006',
};

/** The demo user scripts and fixtures act as. */
export const DEMO_ACTOR_USER_ID = USERS.maya;

/** Demo login emails (B8). `.test` is a reserved domain, so mail never leaves. */
export const DEMO_EMAILS = {
  maya: 'maya@split.test',
  sam: 'sam@split.test',
  priya: 'priya@split.test',
  alex: 'alex@split.test',
};
