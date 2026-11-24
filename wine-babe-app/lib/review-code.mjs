// Salted SHA-256 of the App Store review demo code. The code itself lives only
// in App Store Connect (App Review Information > Password); the "set-review"
// run of .github/workflows/wine-babe-asc.yml makes a new one and prints this
// pair to paste here. WB_REVIEW_CODE (Netlify env) works too.
export const REVIEW_CODE_HASH = {"salt":"be85d3bcb62c382f7f9e6927fe318feb","hash":"70ecfe764d37a902fb9f71285e09f89847bb3efaf4971181fdf4919bd8208978"};
