# Wine Babe Scanner: App Store setup

The iPhone app is a Capacitor shell (this folder) around https://winebabescanner.com.
Build and upload with the "Wine Babe iPhone app (TestFlight)" workflow in GitHub Actions.

## Before the first upload

1. Netlify (Wine Babe site) environment variables:
   - `WB_PUBLIC=true` opens the app to the public (free scan limits apply). Unset, everything stays behind the team password. Must be on before TestFlight testers or App Review use it.
   - `RESEND_API_KEY`, `EMAIL_FROM` (default `Wine Babe Scanner <hello@winebabescanner.com>`), and the winebabescanner.com domain verified in Resend. Needed for sign in codes and feedback emails.
   - `FEEDBACK_TO`: comma list of addresses that get every Share feedback message. Kept out of the repo because it is public.
   - `AUTH_SECRET`: long random string (signs team and account cookies).
   - `WB_REVIEW_EMAIL=review@winebabescanner.com` and `WB_REVIEW_CODE` (8+ characters): the App Review demo login. That email signs in with that fixed code; no email is sent. Never commit the code.
   - Optional limits: `WB_FREE_SCANS` (5), `WB_DAILY_SCANS` (20), `WB_GLOBAL_DAILY` (300), `WB_ANON_IP_DAILY` (15).
2. GitHub repository secrets (same Apple team and App Store Connect API key as the WCI OS app): `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`.
3. App Store Connect: create the app record (fields below), then run the workflow with build number 1.

## App record

| Field | Value |
|---|---|
| Platform | iOS |
| Name | Wine Babe Scanner |
| Primary language | English (U.S.) |
| Bundle ID | com.winebabescanner.app |
| SKU | winebabescanner-ios |
| User access | Full access |

## Listing

- Subtitle (30 max): Scan wine for sugar & calories
- Category: Food & Drink. Secondary: Health & Fitness
- Price: Free
- Privacy policy URL: https://winebabescanner.com/privacy
- Support URL: https://winebabescanner.com/support
- Keywords (100 max): wine,sugar,calories,low sugar,keto,carbs,label,scanner,sulfites,organic,vegan,clean wine
- Promotional text: Point your camera at any bottle and see the sugar, calories and how open the winery is about what's inside.
- Description:

  Cheers to a skinnier sip.

  Wine Babe Scanner reads a wine label and tells you what's really in the bottle. Snap the front label (and the back, if you like) or type the wine's name, and in under a minute you'll see:

  • Sugar per glass and per bottle, and whether it's truly dry
  • Calories and carbs per 5 oz glass
  • Alcohol, sulfites and added ingredients when the winery shares them
  • Organic, vegan and other claims, checked against the winery's own tech sheets
  • A transparency score showing how open the winery is about what's inside

  Your first 5 scans are free with no sign up. After that, a free account (just your name and email) keeps you scanning. Recent scans are saved on your phone so you can look back any time.

  Found a bug or have an idea? Tap Share feedback at the top of the app. We read every one.

  Wine Babe Scanner is for adults of legal drinking age. Please drink responsibly.

## Age rating

Answer "Alcohol, Tobacco, or Drug Use or References" = Frequent. Everything else = None / No. Accept the rating Apple gives (expected 18+).

## App Privacy (nutrition label)

Tracking: No. Data collected:

| Type | Linked to user | Used for |
|---|---|---|
| Contact Info: Name | Yes | App Functionality |
| Contact Info: Email Address | Yes | App Functionality |
| Contact Info: Phone Number (optional) | Yes | App Functionality |
| User Content: Photos or Videos (label photos, deleted after the scan) | No | App Functionality |
| User Content: Customer Support (feedback messages) | Yes | App Functionality |
| Identifiers: Device ID (random app ID for free scan counts) | No | App Functionality |

## App Review notes

> Wine Babe Scanner identifies a wine from a photo of its label (or a typed name) and shows sugar, calories and how transparent the winery is.
>
> No account is needed to try it: the first 5 scans are free. Tap "Scan label" to use the camera, or type a wine name such as "Bonterra Chardonnay" in the search box.
>
> After 5 scans the app asks for a free account (name and email; phone optional). To test signed in features without an inbox, use the demo account: tap "Sign in" at the top, enter review@winebabescanner.com, tap "Email me a code", then enter the demo code below. No email is sent for this account.
>
> Demo email: review@winebabescanner.com
> Demo code: (WB_REVIEW_CODE from Netlify)
>
> Account deletion: tap "Account" at the top, then "Delete my account" and "Delete for good".
> Feedback: tap "Share feedback" at the top.
>
> A scan looks up the winery's published information, so it takes 20 to 60 seconds. Recently scanned wines return in a few seconds.

## Screenshots

iPhone 6.9" (1320 x 2868) is required: home screen, scanning, a result, the score explainer, Share feedback.
