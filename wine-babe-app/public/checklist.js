// Wine Babe Transparency & Quality Checklist.
// Shared by the server (prompt + schema) and the browser (rendering + scoring).
// `top` marks the 10 consumer facing priorities, in order.

const CHECKLIST = [
  {
    id: "sugar",
    title: "Sugar & Nutritional Transparency",
    icon: "🍇",
    items: [
      { id: "tech_sheet", label: "Technical sheet available", ask: "Laboratory analysis showing residual sugar (g/L)." },
      { id: "sugar_under_1g", label: "Less than 1g sugar per 5 oz", ask: "Residual sugar about 6.7 g/L or less.", top: 1 },
      { id: "no_added_sugar", label: "No added sugar", ask: "No sugar, grape concentrate, or other sweeteners added at any stage.", top: 7 },
      { id: "zero_dosage", label: "Zero dosage", ask: "Sparkling only: no sugar added at dosage (Brut Nature, Pas Dosé, Dosaggio Zero)." },
      { id: "calories", label: "Calories per 5 oz", ask: "Lab verified or calculated from reliable data.", top: 10 },
      { id: "carbs", label: "Carbohydrates per serving", ask: "Verified nutritional information." },
      { id: "abv", label: "Alcohol by volume (ABV)", ask: "Confirmed on technical sheet." },
    ],
  },
  {
    id: "ingredients",
    title: "Ingredients & Dietary Standards",
    icon: "🌱",
    items: [
      { id: "non_gmo", label: "Non GMO", ask: "Including ingredients and fermentation yeast. Often stated on the winery tech sheet (e.g. NO OGM).", top: 2 },
      { id: "vegan", label: "Vegan friendly", ask: "No animal derived fining agents or processing aids. Winery statement is enough.", top: 3 },
      { id: "organic", label: "Organic grapes", ask: "Certified organic or documented organic cultivation.", top: 4 },
      { id: "no_artificial_flavors", label: "No added natural or artificial flavors", ask: "Passes when the published ingredient list shows no natural or artificial flavors.", top: 8 },
      { id: "no_natural_flavors", label: "No added natural flavors", ask: "Flavor comes from grapes and fermentation only." },
      { id: "no_artificial_colors", label: "No artificial colors", ask: "No synthetic coloring agents." },
      { id: "no_artificial_sweeteners", label: "No artificial sweeteners", ask: "No added sugar substitutes." },
      { id: "ingredient_transparency", label: "Full ingredient transparency", ask: "A full ingredient list published by the winery, importer or e-label.", top: 11 },
      { id: "gluten_free", label: "Gluten free", ask: "Confirm ingredients and processing practices." },
    ],
  },
  {
    id: "farming",
    title: "Farming & Vineyard Practices",
    icon: "🌿",
    items: [
      { id: "hand_harvested", label: "Hand harvested grapes", ask: "All or some grapes harvested by hand.", top: 5 },
      { id: "sustainable", label: "Sustainable farming", ask: "Winery documentation or a recognized certification (SQNPI, Equalitas, SIP, etc.).", top: 6 },
      { id: "minimal_pesticide", label: "Minimal pesticide use", ask: "Vineyard pest management practices." },
      { id: "no_synthetic_herbicides", label: "No synthetic herbicides", ask: "Verify vineyard practices." },
      { id: "biodiversity", label: "Biodiversity protection", ask: "Cover crops, natural habitats, soil health." },
      { id: "water_conservation", label: "Water conservation", ask: "Responsible irrigation practices." },
      { id: "regenerative", label: "Regenerative agriculture", ask: "Where applicable." },
      { id: "estate_grown", label: "Estate grown grapes", ask: "Grapes from the winery's own vineyards." },
    ],
  },
  {
    id: "winemaking",
    title: "Winemaking & Production",
    icon: "🍷",
    items: [
      { id: "traditional_fermentation", label: "Traditional fermentation", ask: "Understand fermentation methods." },
      { id: "no_added_water", label: "No added water", ask: "No dilution during production." },
      { id: "no_unnecessary_additives", label: "No unnecessary additives", ask: "Complete list of additives and processing aids." },
      { id: "sulfites", label: "Sulfite transparency", ask: "Total and free SO2 levels, and whether sulfites were added.", top: 9 },
      { id: "yeast", label: "Native or selected yeast", ask: "Which fermentation yeast is used." },
      { id: "minimal_intervention", label: "Minimal intervention", ask: "Specific documented practices, not just the marketing term." },
      { id: "no_concentrates", label: "No added concentrates", ask: "No concentrated grape must or other concentrates." },
      { id: "temp_controlled", label: "Temperature controlled fermentation", ask: "Where appropriate for the style." },
    ],
  },
  {
    id: "sourcing",
    title: "Winery & Sourcing",
    icon: "🏡",
    items: [
      { id: "family_owned", label: "Family owned winery", ask: "Verify ownership." },
      { id: "origin", label: "Country & region of origin", ask: "Traceable vineyard location." },
      { id: "single_vineyard", label: "Single vineyard or estate bottled", ask: "When applicable." },
      { id: "grape_variety", label: "Grape variety", ask: "Confirm varietal composition." },
      { id: "vintage", label: "Vintage identification", ask: "Verify the production year." },
      { id: "traceability", label: "Traceability", ask: "Bottles can be connected to production lots." },
      { id: "certifications", label: "Third party certifications", ask: "Organic, sustainability, vegan, or other." },
    ],
  },
  {
    id: "safety",
    title: "Extra Transparency",
    icon: "🔬",
    items: [
      { id: "heavy_metals", label: "Heavy metal testing", ask: "Independent lab results for lead, arsenic, cadmium, other contaminants, specific to the wine and lot." },
    ],
  },
];

// Evidence levels, strongest first.
const EVIDENCE = {
  lab: { label: "Lab report", weight: 1 },
  certified: { label: "Certified", weight: 1 },
  winery: { label: "Winery confirmed", weight: 0.8 },
  third_party: { label: "Third party (EU label)", weight: 0.6 },
  retailer: { label: "Retailer / distributor", weight: 0.5 },
  verified: { label: "Verified", weight: 1 },
  calculated: { label: "Estimated", weight: 0 },
  estimate: { label: "Estimate", weight: 0.3 },
  typical: { label: "Typical for type", weight: 0.2 },
  none: { label: "Not verified", weight: 0 },
};

const SCOPE = {
  this_wine: null,
  producer: "Producer wide",
  related_wine: "Sister wine",
};

const ALL_ITEMS = CHECKLIST.flatMap((c) => c.items.map((i) => ({ ...i, category: c.id })));

if (typeof module !== "undefined") module.exports = { CHECKLIST, EVIDENCE, SCOPE, ALL_ITEMS };
