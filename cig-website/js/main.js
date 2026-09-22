document.addEventListener('DOMContentLoaded', function () {
  function getParam(name) {
    try { return new URLSearchParams(window.location.search).get(name) || ''; }
    catch (e) { return ''; }
  }

  function trackCampaignVisit() {
    var source = getParam('utm_source');
    if (source !== 'email') return;

    var campaign = getParam('utm_campaign') || '';
    var content = getParam('utm_content') || '';
    var path = window.location.pathname + window.location.search;
    var storageKey = 'cig_visit_' + campaign + '_' + content + '_' + window.location.pathname;
    try {
      if (sessionStorage.getItem(storageKey)) return;
      sessionStorage.setItem(storageKey, '1');
    } catch (e) {}

    var encoded = new URLSearchParams();
    encoded.append('form-name', 'campaign-visit');
    encoded.append('utm_source', source);
    encoded.append('utm_medium', getParam('utm_medium'));
    encoded.append('utm_campaign', campaign);
    encoded.append('utm_content', content);
    encoded.append('Landing Page', path);
    encoded.append('Referrer', document.referrer || '');

    fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encoded.toString()
    }).catch(function () {});
  }

  // ===== Footer year =====
  var yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  trackCampaignVisit();

  // ===== Mobile nav toggle =====
  var navToggle = document.getElementById('navToggle');
  var mainNav = document.getElementById('mainNav');
  if (navToggle && mainNav) {
    navToggle.addEventListener('click', function () {
      var isOpen = mainNav.classList.toggle('open');
      navToggle.classList.toggle('open', isOpen);
      navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    mainNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        mainNav.classList.remove('open');
        navToggle.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  if (window.fbq && window.location.pathname.indexOf('/industries/') === 0) {
    fbq('track', 'ViewContent', {
      content_name: document.title,
      content_category: 'industry-landing'
    });
  }

  // ===================================================
  // Multi-step onboarding form
  // ===================================================
  var form = document.getElementById('onboardingForm');
  if (!form) return;

  captureCampaignFields(form);

  var steps = Array.prototype.slice.call(form.querySelectorAll('.form-step'));
  var totalSteps = steps.length;
  var currentStep = 1;
  var isShortForm = form.classList.contains('short-form') || totalSteps <= 1;

  var progressBar = document.getElementById('formProgressBar');
  var stepsLabel = document.getElementById('formStepsLabel');
  var prevBtn = document.getElementById('prevBtn');
  var nextBtn = document.getElementById('nextBtn');
  var submitBtn = document.getElementById('submitBtn');
  var formError = document.getElementById('formError');
  var formSuccess = document.getElementById('formSuccess');
  var reviewGrid = document.getElementById('reviewGrid');

  // ----- Pill (single-select button group) behavior -----
  form.querySelectorAll('.pill-group').forEach(function (group) {
    var fieldName = group.getAttribute('data-name');
    var hiddenInput = form.querySelector('input[type="hidden"][name="' + cssEscape(fieldName) + '"]');
    group.querySelectorAll('.pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        group.querySelectorAll('.pill').forEach(function (p) { p.classList.remove('selected'); });
        pill.classList.add('selected');
        if (hiddenInput) hiddenInput.value = pill.getAttribute('data-value');
        clearError();
      });
    });
  });

  function cssEscape(str) {
    return str.replace(/([ #.;:?%&,+*~'"!^$\[\]()=>|\/@])/g, '\\$1');
  }

  function captureCampaignFields(formEl) {
    var params = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
    params.forEach(function (key) {
      var el = formEl.querySelector('[name="' + key + '"]');
      var value = getParam(key);
      if (el && value) el.value = value;
    });
    var landing = formEl.querySelector('[name="Landing Page"]');
    if (landing) landing.value = window.location.pathname + window.location.search;

    var INDUSTRY_FROM_SLUG = {
      'logistics': 'Logistics / Transportation',
      'accounting': 'Professional Services (Consulting, Accounting, etc.)',
      'insurance': 'Finance / Insurance',
      'construction': 'Construction / Contracting',
      'legal': 'Legal',
      'property-management': 'Property Management',
      'real-estate': 'Real Estate',
      'home-services': 'Home Services (HVAC, Plumbing, Electrical, etc.)'
    };
    var pathParts = window.location.pathname.split('/').filter(Boolean);
    var slug = pathParts[pathParts.length - 1] || '';
    var industryFromUrl = getParam('industry') || INDUSTRY_FROM_SLUG[slug] || '';
    var industrySelect = document.getElementById('industry');
    var industryHidden = formEl.querySelector('input[type="hidden"][name="Industry"]');
    if (industrySelect && industryFromUrl) {
      industrySelect.value = industryFromUrl;
    }
    if (industryHidden && industryFromUrl && !industryHidden.value) {
      industryHidden.value = industryFromUrl;
    }

    var referral = document.getElementById('referral');
    if (referral && getParam('utm_source') === 'email' && !referral.value) {
      var emailOption = 'Email — Jacksonville Wave 1';
      for (var i = 0; i < referral.options.length; i++) {
        if (referral.options[i].value === emailOption) {
          referral.value = emailOption;
          break;
        }
      }
    }
  }

  // ----- Industry-specific software examples -----
  var INDUSTRY_SOFTWARE_EXAMPLES = {
    'Home Services (HVAC, Plumbing, Electrical, etc.)': 'ServiceTitan, Housecall Pro, Jobber, QuickBooks',
    'Construction / Contracting': 'Procore, Buildertrend, CoConstruct, QuickBooks',
    'Real Estate': 'MLS/CRM tools like Follow Up Boss or kvCORE, DocuSign, QuickBooks',
    'Property Management': 'AppFolio, Buildium, Propertyware, QuickBooks',
    'Healthcare / Medical': 'An EHR/EMR system (e.g. Epic, athenahealth), practice management software, QuickBooks',
    'Legal': 'Clio, MyCase, PracticePanther, QuickBooks',
    'Retail / E-Commerce': 'Shopify, Square, WooCommerce, QuickBooks',
    'Hospitality / Food & Beverage': 'Toast, Square, OpenTable, QuickBooks',
    'Professional Services (Consulting, Accounting, etc.)': 'QuickBooks, HubSpot or another CRM, project tools like Asana',
    'Manufacturing': 'An ERP system (e.g. NetSuite, SAP), inventory software, QuickBooks',
    'Finance / Insurance': 'AMS/CRM tools like Applied Epic or Salesforce, QuickBooks',
    'Logistics / Transportation': 'A TMS/dispatch platform (e.g. Samsara, McLeod), QuickBooks',
    'Marketing / Creative Agency': 'HubSpot, Asana or Monday.com, QuickBooks',
    'Nonprofit': 'A donor CRM (e.g. Bloomerang, DonorPerfect), QuickBooks',
    'Technology / SaaS': 'Salesforce or HubSpot, Jira, QuickBooks or Stripe',
    'Other': 'accounting software like QuickBooks, a CRM, and scheduling/invoicing tools'
  };
  var industrySelect = document.getElementById('industry');
  var softwareHint = document.getElementById('softwareHint');
  function updateSoftwareHint() {
    if (!industrySelect || !softwareHint) return;
    var examples = INDUSTRY_SOFTWARE_EXAMPLES[industrySelect.value];
    softwareHint.textContent = examples
      ? 'Common in this industry: ' + examples + '.'
      : 'Think accounting/invoicing, CRM, scheduling, or any tool that runs a part of your day-to-day. Select an industry above for common examples.';
  }
  if (industrySelect) {
    industrySelect.addEventListener('change', updateSoftwareHint);
    updateSoftwareHint();
  }

  function showStep(n) {
    if (isShortForm) return;
    steps.forEach(function (step) {
      step.classList.toggle('active', parseInt(step.getAttribute('data-step'), 10) === n);
    });
    var pct = (n / totalSteps) * 100;
    if (progressBar) progressBar.style.width = pct + '%';
    if (stepsLabel) stepsLabel.textContent = 'Step ' + n + ' of ' + totalSteps;
    if (prevBtn) prevBtn.classList.toggle('show', n > 1);

    if (n === totalSteps) {
      if (nextBtn) nextBtn.style.display = 'none';
      if (submitBtn) submitBtn.style.display = 'inline-flex';
      if (reviewGrid) buildReview();
    } else {
      if (nextBtn) nextBtn.style.display = 'inline-flex';
      if (submitBtn) submitBtn.style.display = 'none';
    }
    clearError();
    var card = form.closest('.form-card');
    if (card) window.scrollTo({ top: card.offsetTop - 110, behavior: 'smooth' });
  }

  function clearError() {
    if (formError) formError.textContent = '';
  }

  function showError(msg) {
    if (formError) formError.textContent = msg;
  }

  function validateStep(n) {
    var stepEl = steps[n - 1];
    if (!stepEl) return true;
    var requiredFields = stepEl.querySelectorAll('[required]');
    var valid = true;
    var firstInvalid = null;

    requiredFields.forEach(function (field) {
      field.classList.add('touched');
      if (field.type === 'hidden') {
        if (!field.value) { valid = false; if (!firstInvalid) firstInvalid = field; }
      } else if (!field.checkValidity()) {
        valid = false;
        if (!firstInvalid) firstInvalid = field;
      }
    });

    if (!valid) {
      if (firstInvalid && firstInvalid.type !== 'hidden' && firstInvalid.focus) {
        firstInvalid.focus();
      }
      showError('Please fill in the required fields before continuing.');
    }
    return valid;
  }

  function validateAllSteps() {
    if (isShortForm) return validateStep(1);
    for (var i = 1; i < totalSteps; i++) {
      var stepEl = steps[i - 1];
      var requiredFields = Array.prototype.slice.call(stepEl.querySelectorAll('[required]'));
      var stepValid = requiredFields.every(function (field) {
        return field.type === 'hidden' ? !!field.value : field.checkValidity();
      });
      if (!stepValid) {
        currentStep = i;
        showStep(currentStep);
        validateStep(currentStep);
        return false;
      }
    }
    return true;
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      if (!validateStep(currentStep)) return;
      if (currentStep < totalSteps) {
        currentStep++;
        showStep(currentStep);
      }
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      if (currentStep > 1) {
        currentStep--;
        showStep(currentStep);
      }
    });
  }

  function buildReview() {
    if (!reviewGrid) return;
    reviewGrid.innerHTML = '';
    var formData = new FormData(form);
    var order = [
      'Full Name', 'Email', 'Phone', 'Company Name', 'Role',
      'Industry', 'Company Size', 'Website', 'Years in Business', 'Business Description',
      'Current Software',
      'Pain Points', 'Biggest Challenge', 'Success Definition',
      'AI Knowledge Level', 'Current Tools', 'Timeline', 'Budget Range',
      'Referral Source', 'Best Time to Contact', 'Additional Info'
    ];

    order.forEach(function (key) {
      var values = formData.getAll(key).filter(Boolean);
      if (!values.length) return;
      var dl = document.createElement('div');
      dl.className = 'review-item';
      var dt = document.createElement('dt');
      dt.textContent = key;
      var dd = document.createElement('dd');
      dd.textContent = values.join(', ');
      dl.appendChild(dt);
      dl.appendChild(dd);
      reviewGrid.appendChild(dl);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!validateAllSteps()) {
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
    }

    var data = new FormData(form);
    var encoded = new URLSearchParams();
    data.forEach(function (value, key) { encoded.append(key, value); });

    var postUrl = form.getAttribute('data-netlify') === 'true'
      ? (window.location.pathname || '/')
      : (form.getAttribute('action') || '/');

    fetch(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encoded.toString()
    })
      .then(function () {
        form.style.display = 'none';
        var progress = document.querySelector('.form-progress');
        if (progress) progress.style.display = 'none';
        if (stepsLabel) stepsLabel.style.display = 'none';
        if (formSuccess) formSuccess.classList.add('show');
        if (window.fbq) {
          fbq('track', 'Lead', {
            content_name: document.title,
            content_category: 'onboarding-form'
          });
        }
      })
      .catch(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit My Info';
        }
        form.submit();
      });
  });

  if (!isShortForm) {
    showStep(currentStep);
  } else if (submitBtn) {
    submitBtn.style.display = 'inline-flex';
  }
});
