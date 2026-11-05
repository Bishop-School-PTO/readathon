// apiUrl: your Apps Script web app URL (Deploy > Manage deployments > Web app URL).
// googleClientId: the OAuth client ID for "Sign in with Google" on /admin. It must
//   match the GOOGLE_CLIENT_ID script property. Client IDs are not secret.
// checkoutApiUrl: the Cloudflare Worker (worker/). Donation pages load their data through
//   its cache, falling back to apiUrl. Leave it empty to always use apiUrl.
// checkoutApiUrl, stripePublishableKey, turnstileSiteKey: the embedded donation form
//   (donate page with ?checkout=embedded). Leave any of them empty and donate pages
//   always use the Stripe Payment Link button. None of these are secret.
// The local dev server (npm run dev) serves its own version of this file.
window.READATHON_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbyTY8HNY1eMpmVgUvF_mlPWiEajmafQjBeOSEwoG-B0hAzCZblGSW13awHJVeNQkCFd8A/exec',
  googleClientId: '69541499158-2dvtvg7bnu311kjdkrpage5j82clpued.apps.googleusercontent.com',
  checkoutApiUrl: 'https://readathon-checkout.bishoppto.workers.dev', // Cloudflare Worker (worker/)
  // Sandbox key: same mode as the Worker's restricted key. Switch both when going live.
  stripePublishableKey: 'pk_test_51UVGhQK9lkVDlZj3FmlnDCugjXJyGXmRIglDYeiIjmDH2X94AHfmayVGYC4L4ivm7tm6Vy4uhpfqMbWNiYJIvvJO00CTiZ4spo',
  turnstileSiteKey: '0x4AAAAAAFzaHzSdKsED970m', // Cloudflare Turnstile widget
};
