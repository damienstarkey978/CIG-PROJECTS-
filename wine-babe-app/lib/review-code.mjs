// Salted SHA-256 of the App Store review demo code. The code itself lives only
// in App Store Connect (App Review Information > Password); the "set-review"
// run of .github/workflows/wine-babe-asc.yml makes a new one and prints this
// pair to paste here. null = only WB_REVIEW_CODE (Netlify env) works.
export const REVIEW_CODE_HASH = null;
