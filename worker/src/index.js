// Worker entry point. Only the default export: Workers treats every named export of
// this module as an entrypoint, so the logic and its constants live in checkout.js.
export { default } from './checkout.js';
