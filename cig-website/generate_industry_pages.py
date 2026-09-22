#!/usr/bin/env python3
"""Generate Wave 1 industry landing pages for CIG."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PAGES = [
    {
        "slug": "logistics",
        "label": "Logistics",
        "industry_value": "Logistics / Transportation",
        "title": "AI for Shipping and Logistics Companies | Custom Intelligence Group",
        "description": "AI employees and automations for Jacksonville shipping companies — so your team stops staying late to answer where a shipment is.",
        "h1_lead": "Give your dispatch team",
        "h1_span": "their nights back.",
        "hero": "A lot of Jacksonville shipping companies have the same problem. Someone on the team stays late answering “where is my shipment?” and cleaning up problem emails. We build AI employees and automations so your people can stop doing that busywork.",
        "pain_h2": "Where shipping companies lose hours.",
        "pains": [
            ("Customers asking where their shipment is", "The same question comes in all day and after hours. Someone has to answer it, or the customer gets angry."),
            ("Problem emails piling up", "Late trucks, appointment changes, and detention notes live in inboxes. Your best people spend the night sorting them."),
            ("Hard to see what is going on", "If you want a clear picture of open problems, you often have to ask around instead of looking at one screen."),
        ],
        "help_h2": "What we would actually build for you.",
        "helps": [
            ("Automations", "Follow-up emails and status updates that go out without someone typing them by hand."),
            ("AI employees", "An AI employee that answers “where is my shipment?” using your existing system, and hands real problems to a person."),
            ("Dashboards", "One screen for open problems, late loads, and unanswered customer questions."),
        ],
        "faqs": [
            ("Will this replace my dispatchers?", "No. We take the repeat questions and busywork so your people can handle the loads that need a human."),
            ("Do we have to switch software?", "No. We plug into the tools you already use."),
            ("How long does this take?", "A simple first version can be live in days. Bigger builds take a few weeks."),
            ("What does it cost?", "It depends on the job. After you send the short form, we look at your workflow and give you a clear number."),
        ],
        "cta": "If your team is still staying late on shipment questions, tell us where the hours go.",
        "form_prompt": "This takes about two minutes. Tell us where your team is losing time. We reply within one business day.",
        "loss_placeholder": "e.g. Someone stays late answering where a shipment is, and problem emails pile up overnight.",
    },
    {
        "slug": "accounting",
        "label": "Accounting",
        "industry_value": "Professional Services (Consulting, Accounting, etc.)",
        "title": "AI for CPA Firms | Custom Intelligence Group",
        "description": "AI employees and automations for accounting firms — so partners stop chasing documents and answering “did you get this?”",
        "h1_lead": "Give your accountants",
        "h1_span": "their busy season back.",
        "hero": "Busy season at a lot of firms looks the same. Partners answer “did you get my documents?” while staff chase organizers. We build AI employees and automations so your CPAs can spend time on review and advice — not document collection.",
        "pain_h2": "Where accounting firms lose hours.",
        "pains": [
            ("Chasing documents", "Staff spend days following up on W-2s, organizers, and missing files."),
            ("The same client email, over and over", "“Did you get this?” should not eat partner time in busy season."),
            ("Work sitting in inboxes", "Bookkeeping problems and client questions get lost in email instead of a simple list."),
        ],
        "help_h2": "What we would actually build for you.",
        "helps": [
            ("Automations", "Chase emails for missing documents, sent from your process — not from a partner’s memory."),
            ("AI employees", "An AI employee that sorts what came in, flags what is missing, and drafts the follow-up. A CPA still handles anything that looks like advice."),
            ("Dashboards", "One view of outstanding organizers, aging client requests, and what still needs a person."),
        ],
        "faqs": [
            ("Will this replace my CPAs?", "No. We take document chase and repeat questions so your people keep review, advice, and client relationships."),
            ("Does the AI give tax advice?", "No. Anything that looks like advice goes to a CPA."),
            ("Do we have to switch software?", "No. We plug into the portal, email, and accounting tools you already use."),
            ("What does it cost?", "It depends on the job. After you send the short form, we look at your workflow and give you a clear number."),
        ],
        "cta": "If your CPAs are still chasing documents, tell us where the hours go.",
        "form_prompt": "This takes about two minutes. Tell us where your team is losing time. We reply within one business day.",
        "loss_placeholder": "e.g. Partners spend busy season answering did you get my documents, while staff chase organizers.",
    },
    {
        "slug": "insurance",
        "label": "Insurance",
        "industry_value": "Finance / Insurance",
        "title": "AI for Insurance Agencies | Custom Intelligence Group",
        "description": "AI employees and automations for insurance agencies — so CSRs stop spending the day on certificate requests.",
        "h1_lead": "Get certificates",
        "h1_span": "off your team’s plate.",
        "hero": "Certificate requests and “just checking on my quote” emails eat the day at a lot of Jacksonville agencies. We build AI employees and automations so your people can sell and advise — not file the same paperwork over and over.",
        "pain_h2": "Where insurance agencies lose hours.",
        "pains": [
            ("Certificate requests all day", "CSRs spend hours issuing certificates instead of helping clients."),
            ("Quote follow-up that dies in the inbox", "“Just checking on my quote” sits unanswered and the business walks."),
            ("After-hours questions", "Payment and “did you get this?” calls still land on a person, or they get missed."),
        ],
        "help_h2": "What we would actually build for you.",
        "helps": [
            ("Automations", "Certificate and quote follow-up that runs on a list, not on whoever remembered."),
            ("AI employees", "An AI employee that handles repeat certificate and payment questions. A licensed person still handles coverage advice."),
            ("Dashboards", "One view of open quotes, stale follow-ups, and certificate volume."),
        ],
        "faqs": [
            ("Will this replace my producers or CSRs?", "No. We take the certificate queue and repeat questions so your people can sell and advise."),
            ("Does the AI recommend coverage?", "No. Anything that looks like advice stays with a licensed person."),
            ("Do we have to switch software?", "No. We plug into the agency system you already pay for."),
            ("What does it cost?", "It depends on the job. After you send the short form, we look at your workflow and give you a clear number."),
        ],
        "cta": "If certificates are still eating the day, tell us where the hours go.",
        "form_prompt": "This takes about two minutes. Tell us where your team is losing time. We reply within one business day.",
        "loss_placeholder": "e.g. CSRs spend half the day on certificate requests and quote follow-up emails.",
    },
    {
        "slug": "construction",
        "label": "Construction",
        "industry_value": "Construction / Contracting",
        "title": "AI for Construction Companies | Custom Intelligence Group",
        "description": "AI employees and automations for general contractors — so project managers can be on the job, not stuck in email.",
        "h1_lead": "Get your project managers",
        "h1_span": "out of their inbox.",
        "hero": "A lot of Jacksonville contractors have project managers living in email — RFIs, subcontractor updates, change orders written down too late. We build AI employees and automations so your PMs can be on the job. They still make the calls that protect the work.",
        "pain_h2": "Where construction companies lose hours.",
        "pains": [
            ("Project managers stuck in email", "RFIs and subcontractor updates turn PMs into a full-time inbox."),
            ("Change orders written down too late", "If it is not documented, you often cannot collect on it."),
            ("Bid files built by hand", "Estimators rebuild folders from scattered PDFs before they can even price the job."),
        ],
        "help_h2": "What we would actually build for you.",
        "helps": [
            ("Automations", "Follow-up with subcontractors and a simple log of change-order notes from email."),
            ("AI employees", "An AI employee that drafts RFI replies for the PM. The PM still sends anything that matters."),
            ("Dashboards", "One view of open RFIs, aging subcontractor replies, and unapproved changes."),
        ],
        "faqs": [
            ("Will this replace my project managers?", "No. We take inbox busywork so they can be on the job. They still make the calls that protect the work."),
            ("Do we have to switch software?", "No. We plug into email and tools like Procore or Buildertrend if you already use them."),
            ("How long does this take?", "A simple first version can be live in days. Bigger builds take a few weeks."),
            ("What does it cost?", "It depends on the job. After you send the short form, we look at your workflow and give you a clear number."),
        ],
        "cta": "If your PMs are still living in email, tell us where the hours go.",
        "form_prompt": "This takes about two minutes. Tell us where your team is losing time. We reply within one business day.",
        "loss_placeholder": "e.g. Project managers spend the day on RFI email, and change orders get written down too late.",
    },
    {
        "slug": "legal",
        "label": "Legal",
        "industry_value": "Legal",
        "title": "AI for Law Firms | Custom Intelligence Group",
        "description": "AI employees and automations for law firms — intake and status emails, not a robot lawyer.",
        "h1_lead": "Stop spending lawyer time",
        "h1_span": "on status emails.",
        "hero": "Intake packets and “what’s the status?” emails chew up paralegal and attorney hours at a lot of Jacksonville firms. We build AI employees and automations for that busywork. We do not replace lawyers. We do not give legal advice.",
        "pain_h2": "Where law firms lose hours.",
        "pains": [
            ("Intake that lives in voicemail and PDFs", "New matters start with phone tag and incomplete packets."),
            ("“What’s the status?” every week", "Clients ask. Someone has to write the same email again."),
            ("Chasing records", "Paralegals spend days following up on medical records and discovery files."),
        ],
        "help_h2": "What we would actually build for you.",
        "helps": [
            ("Automations", "Reminders for missing intake items and records, so a person is not the reminder system."),
            ("AI employees", "An AI employee that gathers intake facts and drafts status notes. A lawyer still reviews anything that matters. It never gives legal advice."),
            ("Dashboards", "One view of new matters, incomplete packets, and aging records."),
        ],
        "faqs": [
            ("Will this replace attorneys or paralegals?", "No. We take intake and status busywork so they can do counsel, strategy, and court."),
            ("Does the AI give legal advice?", "No. That is the point. Anything substantive stays with a lawyer."),
            ("Do we have to switch software?", "No. We plug into the practice system you already use."),
            ("What does it cost?", "It depends on the job. After you send the short form, we look at your workflow and give you a clear number."),
        ],
        "cta": "If status email is still eating lawyer time, tell us where the hours go.",
        "form_prompt": "This takes about two minutes. Tell us where your team is losing time. We reply within one business day.",
        "loss_placeholder": "e.g. Attorneys and paralegals still write the same status email every week, and intake packets are incomplete.",
    },
    {
        "slug": "property-management",
        "label": "Property Management",
        "industry_value": "Property Management",
        "title": "AI for Property Management Companies | Custom Intelligence Group",
        "description": "AI employees and automations for property managers — after-hours tenant requests without a 24/7 switchboard.",
        "h1_lead": "Give your coordinators",
        "h1_span": "their nights back.",
        "hero": "After-hours lockouts, leaks, and “is this an emergency?” texts turn coordinators into a 24/7 switchboard. We build AI employees and automations that sort those requests. Your people still handle visits, vendors, and anything expensive.",
        "pain_h2": "Where property managers lose hours.",
        "pains": [
            ("Nights and weekends on the phone", "Lockouts and leaks do not wait for office hours. Someone has to sort emergency from “deal with it in the morning.”"),
            ("Work orders bouncing around", "Tenants, vendors, and your team lose track of who is doing what."),
            ("Owners asking for reports that already exist", "The numbers are in the software. Someone still has to pull them and write the email."),
        ],
        "help_h2": "What we would actually build for you.",
        "helps": [
            ("Automations", "Work orders logged into the system you already use, without retyping."),
            ("AI employees", "An AI employee that sorts after-hours tenant messages: emergency vs. morning. A person still approves expensive vendor dispatch."),
            ("Dashboards", "One view of open work orders, after-hours volume, and owner questions waiting on a reply."),
        ],
        "faqs": [
            ("Will this replace my coordinators?", "No. We take the night-shift switchboard so they can handle visits, vendors, and judgment calls."),
            ("Do we have to switch software?", "No. We plug into AppFolio, Buildium, or whatever you already use."),
            ("Who decides if a vendor goes out?", "Your people. The AI sorts the request. A human approves anything expensive."),
            ("What does it cost?", "It depends on the job. After you send the short form, we look at your workflow and give you a clear number."),
        ],
        "cta": "If your team is still the night switchboard, tell us where the hours go.",
        "form_prompt": "This takes about two minutes. Tell us where your team is losing time. We reply within one business day.",
        "loss_placeholder": "e.g. Coordinators get lockout and leak texts all night, and we cannot tell what is an emergency until morning.",
    },
]


def page_html(p):
    pain_cards = "\n".join(
        f'''        <div class="card">
          <h3>{title}</h3>
          <p>{body}</p>
        </div>'''
        for title, body in p["pains"]
    )
    help_cards = "\n".join(
        f'''        <div class="card">
          <h3>{title}</h3>
          <p>{body}</p>
        </div>'''
        for title, body in p["helps"]
    )
    faqs = "\n".join(
        f'''        <details>
          <summary>{q}</summary>
          <p>{a}</p>
        </details>'''
        for q, a in p["faqs"]
    )
    url = f"https://customintelligencegroup.com/industries/{p['slug']}/"
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{p["title"]}</title>
<meta name="description" content="{p["description"]}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Custom Intelligence Group">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{p["title"]}">
<meta property="og:description" content="{p["description"]}">
<meta property="og:image" content="https://customintelligencegroup.com/images/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{p["title"]}">
<meta name="twitter:description" content="{p["description"]}">
<meta name="twitter:image" content="https://customintelligencegroup.com/images/og-image.png">
<link rel="icon" type="image/png" href="../../images/cig-logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../../css/style.css">
<script>
!function(f,b,e,v,n,t,s)
{{if(f.fbq)return;n=f.fbq=function(){{n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)}};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1786237569210028');
fbq('track', 'PageView');
</script>
</head>
<body>
<header class="site-header" id="siteHeader">
  <div class="container nav-inner">
    <a href="../../index.html" class="brand">
      <img src="../../images/cig-logo-icon.png" alt="" class="brand-icon" aria-hidden="true">
      <img src="../../images/cig-logo-wordmark.png" alt="Custom Intelligence Group" class="brand-wordmark">
    </a>
    <nav class="main-nav" id="mainNav">
      <a href="../../index.html#services">Services</a>
      <a href="../../index.html#process">Process</a>
      <a href="../../index.html#industries">Industries</a>
      <a href="#onboarding" class="nav-cta">Get Started</a>
    </nav>
    <button class="nav-toggle" id="navToggle" aria-label="Toggle menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </div>
</header>

<main id="top">
  <section class="hero">
    <div class="hero-bg" aria-hidden="true"></div>
    <div class="container hero-inner">
      <p class="eyebrow">Industries &bull; {p["label"]}</p>
      <h1>{p["h1_lead"]} <span>{p["h1_span"]}</span></h1>
      <p class="hero-sub">{p["hero"]}</p>
      <div class="hero-actions">
        <a href="#onboarding" class="btn btn-primary">Tell us where you are losing time</a>
      </div>
    </div>
  </section>

  <section class="section services">
    <div class="container">
      <p class="section-eyebrow">Where It Hurts</p>
      <h2>{p["pain_h2"]}</h2>
      <div class="cards services-grid">
{pain_cards}
      </div>
    </div>
  </section>

  <section class="section section-alt">
    <div class="container">
      <p class="section-eyebrow">How We Help</p>
      <h2>{p["help_h2"]}</h2>
      <p class="section-lead">Custom Intelligence Group builds AI employees and automations to save your people time. We learn how your company actually works, then we take the repetitive tasks off their plate. We do not replace your people.</p>
      <div class="cards services-grid" style="margin-top:48px;">
{help_cards}
      </div>
    </div>
  </section>

  <section id="onboarding" class="section onboarding">
    <div class="container onboarding-inner">
      <div class="onboarding-intro">
        <p class="section-eyebrow">Start Here</p>
        <h2>{p["cta"]}</h2>
        <p class="section-lead">{p["form_prompt"]}</p>
        <ul class="onboarding-points">
          <li>No cost, no obligation</li>
          <li>We reply within one business day</li>
          <li>We do not sell your information</li>
        </ul>
      </div>
      <div class="form-card short-form">
        <form name="email-campaign-onboarding" id="onboardingForm" class="short-form" method="POST" data-netlify="true" netlify-honeypot="bot-field" action="/thank-you.html" novalidate>
          <input type="hidden" name="form-name" value="email-campaign-onboarding">
          <input type="hidden" name="Industry" value="{p["industry_value"]}">
          <input type="hidden" name="Referral Source" value="Email — Jacksonville Wave 1">
          <input type="hidden" name="utm_source" value="">
          <input type="hidden" name="utm_medium" value="">
          <input type="hidden" name="utm_campaign" value="">
          <input type="hidden" name="utm_content" value="">
          <input type="hidden" name="Landing Page" value="">
          <p class="hidden-field"><label>Don't fill this out if you're human: <input name="bot-field"></label></p>
          <div class="form-step active" data-step="1">
            <h3>Tell us about the busywork.</h3>
            <div class="form-row">
              <div class="form-field">
                <label for="fullName">Your name *</label>
                <input type="text" id="fullName" name="Full Name" required autocomplete="name">
              </div>
              <div class="form-field">
                <label for="email">Work email *</label>
                <input type="email" id="email" name="Email" required autocomplete="email">
              </div>
            </div>
            <div class="form-field">
              <label for="companyName">Company *</label>
              <input type="text" id="companyName" name="Company Name" required autocomplete="organization">
            </div>
            <div class="form-field">
              <label for="timeLost">Where is your team losing time? *</label>
              <textarea id="timeLost" name="Where time is lost" rows="4" required placeholder="{p["loss_placeholder"]}"></textarea>
            </div>
          </div>
          <div class="form-nav">
            <button type="submit" class="btn btn-primary" id="submitBtn">Send this to CIG</button>
          </div>
          <p class="form-error" id="formError" role="alert"></p>
        </form>
        <div class="form-success" id="formSuccess">
          <div class="success-icon">&#10003;</div>
          <h3>You're in.</h3>
          <p>Thanks — we got it. Someone from Custom Intelligence Group will reach out within one business day.</p>
        </div>
      </div>
    </div>
  </section>

  <section id="faq" class="section faq">
    <div class="container">
      <p class="section-eyebrow">Questions</p>
      <h2>Straight answers.</h2>
      <div class="faq-list">
{faqs}
      </div>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="container footer-inner">
    <div class="footer-brand">
      <div class="footer-brand-logo">
        <img src="../../images/cig-logo-icon-white.png" alt="" class="footer-icon" aria-hidden="true">
        <img src="../../images/cig-logo-wordmark-white.png" alt="Custom Intelligence Group" class="footer-wordmark">
      </div>
      <p>AI Integration &bull; Automation &bull; Solutions</p>
    </div>
    <div class="footer-links">
      <a href="../../index.html#services">Services</a>
      <a href="../../index.html#process">Process</a>
      <a href="../../index.html#industries">Industries</a>
      <a href="#onboarding">Get Started</a>
    </div>
    <div class="footer-contact">
      <a href="mailto:hello@customintelligencegroup.com">hello@customintelligencegroup.com</a>
    </div>
  </div>
  <div class="container footer-bottom">
    <p>&copy; <span id="year"></span> Custom Intelligence Group. All rights reserved.</p>
  </div>
</footer>
<form name="campaign-visit" method="POST" data-netlify="true" netlify-honeypot="visit-bot" hidden aria-hidden="true">
  <input type="hidden" name="form-name" value="campaign-visit">
  <input type="text" name="utm_source">
  <input type="text" name="utm_medium">
  <input type="text" name="utm_campaign">
  <input type="text" name="utm_content">
  <input type="text" name="Landing Page">
  <input type="text" name="Referrer">
  <p class="hidden-field"><label>Don't fill this out if you're human: <input name="visit-bot"></label></p>
</form>
<script src="../../js/main.js"></script>
</body>
</html>
'''


def main():
    for p in PAGES:
        dest = ROOT / "industries" / p["slug"] / "index.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(page_html(p), encoding="utf-8")
        print("wrote", dest)


if __name__ == "__main__":
    main()
