// apiUrl: your Apps Script web app URL (Deploy > Manage deployments > Web app URL).
// googleClientId: the OAuth client ID for "Sign in with Google" on /admin. It must
//   match the GOOGLE_CLIENT_ID script property. Client IDs are not secret.
// checkoutApiUrl, stripePublishableKey, turnstileSiteKey: the embedded donation form
//   (donate page with ?checkout=embedded). Leave any of them empty and donate pages
//   always use the Stripe Payment Link button. None of these are secret.
// The local dev server (npm run dev) serves its own version of this file.
window.READATHON_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbyTY8HNY1eMpmVgUvF_mlPWiEajmafQjBeOSEwoG-B0hAzCZblGSW13awHJVeNQkCFd8A/exec',
  googleClientId: '69541499158-2dvtvg7bnu311kjdkrpage5j82clpued.apps.googleusercontent.com',
  checkoutApiUrl: '',       // the Cloudflare Worker, e.g. https://readathon-checkout.<account>.workers.dev
  stripePublishableKey: '', // pk_test_... or pk_live_..., same mode as the Worker's secret key
  turnstileSiteKey: '',     // Cloudflare Turnstile widget site key
};
