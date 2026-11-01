/**
 * The wording a person agrees to. These are first drafts that have NOT had legal review (see ASSUMPTIONS.md). Changing the
 * text means bumping the version, so every consent on record says exactly what was shown.
 */
export const POOL_CONSENT_VERSION = 'float-pool-v1';
export const POOL_CONSENT_TEXT = [
  'If you join a regional float pool, facilities in that region that have agreed to the exchange terms can see an anonymous profile card: your profession, specialties, city and state, years of experience, the status of your credentials, and the days and times you have said you are available.',
  'They never see your name, contact details, employers, schools, pay expectations, credential numbers or documents, and they cannot see who else you work for.',
  'A facility can send you a request for a specific shift. Your identity is shared with that facility only if you accept. You can decline, and you can leave the pool at any time; leaving withdraws requests you have not answered.',
  'Accepting a request books the shift like any other. Your credentials and schedule are checked again when you accept.',
].join('\n\n');

export const EXCHANGE_TERMS_VERSION = 'exchange-terms-v1';
export const EXCHANGE_TERMS_TEXT = [
  'By joining the regional exchange for a region, your organization agrees to use pool information only to request professionals for your own open shifts in that region.',
  'Pool members are shown anonymously. You must not try to identify, contact or recruit a pool member outside the platform, copy or share pool information with others, or use it to discourage a professional from working elsewhere.',
  'You may not use the exchange to agree with other facilities on pay rates, or to coordinate who may hire whom. You set the rate for each request yourself.',
  'BSM may suspend your participation for breaking these terms.',
].join('\n\n');
