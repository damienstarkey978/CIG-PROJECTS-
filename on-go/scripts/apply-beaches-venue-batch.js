'use strict';

/**
 * One-shot apply: append pending Beaches venues to SEED_BUSINESSES,
 * wire logos.js websites/official logos, rebuild enrichment-cache.json
 * (drops Fly's Tie), bump SW cache.
 *
 * Run: node scripts/apply-beaches-venue-batch.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const NEW_SEEDS = [
  {
    name: 'Surfer the Bar',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '200 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 372-9756',
    lat: 30.2905266,
    lng: -81.3900981,
    hours_json: JSON.stringify({ tue_fri: '16-2', sat_sun: '11-2', mon: 'closed' }),
    osm_ref: 'overpass:surfer-the-bar',
  },
  {
    name: "Mango's Beach Bar & Grille",
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '602 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 246-4200',
    lat: 30.2942306,
    lng: -81.3909948,
    hours_json: JSON.stringify({ daily: '11-2' }),
    osm_ref: 'address:602-1st-st-n',
  },
  {
    name: "Ginger's Place",
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '304 3rd St S, Jacksonville Beach, FL 32250',
    phone: '(904) 249-8711',
    lat: 30.2851579,
    lng: -81.3914062,
    hours_json: JSON.stringify({ daily: '13-2' }),
    osm_ref: 'address:304-3rd-st-s',
  },
  {
    name: 'Wreck Tiki Lounge',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '401 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 247-0507',
    lat: 30.2936114,
    lng: -81.3904478,
    hours_json: JSON.stringify({ mon: '16-22' }),
    osm_ref: 'address:401-1st-st-n-wreck',
  },
  {
    name: 'Sandbar Jax Beach',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: '465 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 246-6160',
    lat: 30.2937257,
    lng: -81.3904705,
    hours_json: JSON.stringify({ sun_thu: '11-22', fri_sat: '11-23' }),
    osm_ref: 'overpass:pier-cantina-sandbar',
  },
  {
    name: 'The Ritz Lounge',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '185 3rd Ave N, Jacksonville Beach, FL 32250',
    phone: '(904) 246-2255',
    lat: 30.2923349,
    lng: -81.391035,
    hours_json: JSON.stringify({ daily: '13-2' }),
    osm_ref: 'address:185-3rd-ave-n',
  },
  {
    name: "Lucky's Bar",
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '333 1st St N #150, Jacksonville Beach, FL 32250',
    phone: '(904) 222-0796',
    lat: 30.2916409,
    lng: -81.3902345,
    hours_json: JSON.stringify({ wed_thu: '17-2', fri_sun: '15-2', mon_tue: 'closed' }),
    osm_ref: 'address:333-1st-st-n-150',
  },
  {
    name: 'Tavern on 1st',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '401 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 247-0507',
    lat: 30.2924628,
    lng: -81.3899486,
    hours_json: JSON.stringify({ mon_fri: '16-2', sat_sun: '13-2' }),
    osm_ref: 'overpass:tavern-on-1st',
  },
  {
    name: 'Salt Beachside Bar',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '1515 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 241-2311',
    lat: 30.302903,
    lng: -81.391849,
    hours_json: JSON.stringify({ daily: 'until-22' }),
    osm_ref: 'address:1515-1st-st-n-hampton',
  },
  {
    name: 'Flask & Cannon',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '528 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 853-6633',
    lat: 30.2938201,
    lng: -81.3907128,
    hours_json: JSON.stringify({ mon_thu: '11-22', fri_sat: '11-23', sun: '10-21' }),
    osm_ref: 'address:528-1st-st-n-vpizza',
  },
  {
    name: 'Brix Taphouse & Bar',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '300 2nd St N, Jacksonville Beach, FL 32250',
    phone: '(904) 241-4668',
    lat: 30.2913014,
    lng: -81.3913324,
    hours_json: JSON.stringify({ sun_thu: '11-23', fri_sat: '11-24' }),
    osm_ref: 'overpass:brix-taphouse',
  },
  {
    name: "Pusser's Bar and Grille",
    area: 'Ponte Vedra Beach',
    category: 'Bar',
    address: '816 A1A N Suite 100, Ponte Vedra Beach, FL 32082',
    phone: '(904) 280-7766',
    lat: 30.201062,
    lng: -81.381256,
    hours_json: JSON.stringify({ sun_thu: '11-21', fri_sat: '11-22' }),
    osm_ref: 'exa:pussers-pvb',
  },
  {
    name: 'Jax Beach Bar & Grill',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: '265 5th Ave N, Jacksonville Beach, FL 32250',
    phone: '(904) 746-7774',
    lat: 30.2941017,
    lng: -81.3924804,
    hours_json: JSON.stringify({}),
    osm_ref: 'address:265-5th-ave-n',
  },
  {
    name: 'Kava & Co',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '223 9th Ave S, Jacksonville Beach, FL 32250',
    phone: '(904) 595-5150',
    lat: 30.2801026,
    lng: -81.3897947,
    hours_json: JSON.stringify({}),
    osm_ref: 'address:223-9th-ave-s',
  },
  {
    name: 'Factory After Dark',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '1396 Beach Blvd, Jacksonville Beach, FL 32250',
    phone: '(904) 372-0366',
    lat: 30.2875192,
    lng: -81.4040388,
    hours_json: JSON.stringify({}),
    osm_ref: 'address:1396-beach-blvd',
  },
  {
    name: 'LandShark Bar & Grill',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: '715 1st St N, Jacksonville Beach, FL 32250',
    phone: '(904) 222-0222',
    lat: 30.2954067,
    lng: -81.390692,
    hours_json: JSON.stringify({}),
    osm_ref: 'address:715-1st-st-n-margaritaville',
  },
  {
    name: "Monkey's Uncle Tavern",
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '1728 3rd St N, Jacksonville Beach, FL 32250',
    phone: '(904) 246-1070',
    lat: 30.3045241,
    lng: -81.3958344,
    hours_json: JSON.stringify({}),
    osm_ref: 'address:1728-3rd-st-n',
  },
  {
    name: '1912 Ocean Bar & Rooftop',
    area: 'Ponte Vedra Beach',
    category: 'Bar',
    address: '619 Ponte Vedra Blvd, Ponte Vedra Beach, FL 32082',
    phone: '(904) 373-2063',
    lat: 30.2172861,
    lng: -81.3716646,
    hours_json: JSON.stringify({ mon_sat: '16-22', sun_brunch: '11-14' }),
    osm_ref: 'address:619-ponte-vedra-blvd',
  },
  {
    name: 'Sneakers Sports Grille',
    area: 'Jacksonville Beach',
    category: 'Dinner',
    address: '111 Beach Blvd, Jacksonville Beach, FL 32250',
    phone: '(904) 482-1000',
    lat: 30.2888403,
    lng: -81.3900168,
    hours_json: JSON.stringify({ sun_thu: '11-22', fri_sat: '11-24' }),
    osm_ref: 'overpass:sneakers-sports-grille',
  },
  {
    name: 'Green Room Brewing',
    area: 'Jacksonville Beach',
    category: 'Bar',
    address: '228 3rd St N, Jacksonville Beach, FL 32250',
    phone: '(904) 201-9283',
    lat: 30.2907112,
    lng: -81.3926017,
    hours_json: JSON.stringify({
      mon: 'closed',
      tue_thu: '15-24',
      fri: '15-1',
      sat: '12-1',
      sun: '12-22',
    }),
    osm_ref: 'address:228-3rd-st-n',
  },
  {
    name: 'Harbor Tavern',
    area: 'Atlantic Beach',
    category: 'Bar',
    address: '160 Mayport Rd, Atlantic Beach, FL 32233',
    phone: '(904) 246-2555',
    lat: 30.3258562,
    lng: -81.4193621,
    hours_json: JSON.stringify({ daily: '11-2' }),
    osm_ref: 'address:160-mayport-rd',
  },
  {
    name: 'Dragonfly Lounge',
    area: 'Neptune Beach',
    category: 'Bar',
    address: '1505 Atlantic Blvd #1537, Neptune Beach, FL 32266',
    phone: '(904) 903-7162',
    lat: 30.3235608,
    lng: -81.4145501,
    hours_json: JSON.stringify({
      mon: '11-22',
      tue: 'closed',
      wed_thu: '11-22',
      fri_sat: '11-24',
      sun: '11-22',
    }),
    osm_ref: 'address:1505-atlantic-blvd-1537',
  },
  {
    name: "Culhane's Irish Pub",
    area: 'Atlantic Beach',
    category: 'Bar',
    address: '967 Atlantic Blvd, Atlantic Beach, FL 32233',
    phone: '(904) 249-9595',
    lat: 30.3257567,
    lng: -81.410551,
    hours_json: JSON.stringify({
      mon: '11:30-24',
      tue_wed: '11:30-22',
      thu: '11:30-24',
      fri: '11:30-1:30',
      sat: '9-1:30',
      sun: '8:30-24',
    }),
    osm_ref: 'address:967-atlantic-blvd-ab',
  },
];

const NEW_WEBSITES = {
  'Surfer the Bar': 'https://surferthebar.com/',
  "Mango's Beach Bar & Grille": 'https://www.mangosjaxbeach.com/',
  "Ginger's Place": 'https://www.gingers-place.net/',
  'Wreck Tiki Lounge': 'https://wrecktikilounge.com/',
  'Sandbar Jax Beach': 'https://www.jaxbeachsandbar.com/',
  'The Ritz Lounge': 'https://www.the-ritz-lounge.com/',
  'Flask & Cannon': 'https://www.vpizza.com/locations/jacksonville-beach-fl/',
  'Brix Taphouse & Bar': 'https://jacksonvillebeachbar.com/',
  "Pusser's Bar and Grille": 'https://pusserspvb.com/',
  'Jax Beach Bar & Grill': 'https://www.jaxbeachbarandgrill.com/',
  'Kava & Co': 'https://kavaandcompany.com/',
  'LandShark Bar & Grill':
    'https://www.margaritavilleresorts.com/margaritaville-hotel-jacksonville-beach/eat-drink/landshark-bar-grill',
  "Monkey's Uncle Tavern": 'https://monkeysuncletavern.com/',
  '1912 Ocean Bar & Rooftop': 'https://www.1912oceanbarandrooftop.com/',
  'Sneakers Sports Grille': 'https://sneakerssportsgrille.com/',
  'Green Room Brewing': 'https://greenroombrewing.com/',
  'Dragonfly Lounge': 'https://dragonflylounge-beaches.com/',
  "Culhane's Irish Pub": 'https://www.culhanesirishpub.com/',
};

const NEW_OFFICIAL_LOGOS = {
  'Surfer the Bar': '/assets/venues/surfer-the-bar.png',
  "Mango's Beach Bar & Grille": '/assets/venues/mangos-beach-bar.jpg',
  "Ginger's Place": '/assets/venues/gingers-place.jpg',
  'Wreck Tiki Lounge': '/assets/venues/wreck-tiki-lounge.png',
  'Sandbar Jax Beach': '/assets/venues/sandbar-jax-beach.png',
  'The Ritz Lounge': '/assets/venues/the-ritz-lounge.png',
  "Lucky's Bar": '/assets/venues/luckys-bar.png',
  'Tavern on 1st': '/assets/venues/tavern-on-1st.png',
  'Salt Beachside Bar': '/assets/venues/salt-beachside-bar.png',
  'Brix Taphouse & Bar': '/assets/venues/brix-taphouse.png',
  "Pusser's Bar and Grille": '/assets/venues/pussers-bar-grille.png',
  'Jax Beach Bar & Grill': '/assets/venues/jax-beach-bar-grill.png',
  'LandShark Bar & Grill': '/assets/venues/landshark-bar-grill.png',
  "Monkey's Uncle Tavern": '/assets/venues/monkeys-uncle-tavern.png',
  '1912 Ocean Bar & Rooftop': '/assets/venues/1912-ocean-bar.png',
  'Sneakers Sports Grille': '/assets/venues/sneakers-sports-grille.png',
  'Harbor Tavern': '/assets/venues/harbor-tavern.png',
  'Dragonfly Lounge': '/assets/venues/dragonfly-lounge.png',
  "Culhane's Irish Pub": '/assets/venues/culhanes-irish-pub.png',
};

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const NEW_ENRICHMENT = [
  {
    name: 'The Local',
    website: 'https://www.thelocaljax.com',
    phone: '(904) 372-9791',
    address: '301 Atlantic Blvd, Neptune Beach, FL 32266',
    about_text:
      'Neighborhood New American restaurant in Neptune Beach — Mediterranean, Asian, and Southern flavors for brunch through dinner.',
    about_source: 'venue_website',
    hours_display: 'Mon–Wed 9am–10pm · Thu–Sat 9am–12am · Sun 9am–9pm',
    hours_source: 'venue_website',
    menu_url: 'https://www.thelocaljax.com/menus/neptune-beach-happy-hour-ordering',
    menu_notes: null,
    happy_hour_notes: 'Daily 3-6pm',
    specials_notes: '$1 off oysters · $2 off apps · $3 off drinks (HH menu)',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.thelocaljax.com/',
      'https://www.thelocaljax.com/menus/neptune-beach-happy-hour-ordering',
      'https://www.visitjacksonville.com/',
    ]),
    happy_hour_menu_url: 'https://www.thelocaljax.com/menus/neptune-beach-happy-hour-ordering',
  },
  {
    name: 'Island Girl Cigar Bar (Neptune Beach)',
    website: 'https://islandgirlcigarbar.com/neptune-beach/',
    phone: '(904) 372-4194',
    address: '108 1st Street, Neptune Beach, FL 32266',
    about_text: 'Wine and cigar bar in Beaches Town Center, Neptune Beach.',
    about_source: 'venue_website',
    hours_display: 'Sun–Wed 11am–1am · Thu–Sat 11am–2am',
    hours_source: 'venue_website',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: 'Site advertises Daily Happy Hour — exact days/times not published on official pages researched',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://islandgirlcigarbar.com/neptune-beach/',
      'hh_advertised_but_no_published_days_times',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Island Girl Cigar Bar (Mayport)',
    website: 'https://islandgirlcigarbar.com/mayport/',
    phone: '(904) 595-5042',
    address: '2294 Mayport Road #25, Atlantic Beach, FL 32233',
    about_text: 'Island Girl cigar and wine bar at Mayport / Atlantic Beach.',
    about_source: 'venue_website',
    hours_display: 'Daily 11am–2am',
    hours_source: 'venue_website',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://islandgirlcigarbar.com/mayport/',
      'no_confirmed_hh_schedule',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: "Mr. Chubby's Wings",
    website: 'https://mrchubbyswings.com/ponte-vedra-beach-location',
    phone: '(904) 500-9464',
    address: '150 Valley Circle, Ponte Vedra Beach, FL 32082',
    about_text: 'Wings, sports, and casual dining at the Ponte Vedra Beach location.',
    about_source: 'venue_website',
    hours_display: 'Sun–Thu 11am–11pm · Fri–Sat 11am–12am',
    hours_source: 'venue_website',
    menu_url: 'https://mrchubbyswings.com/ponte-vedra-beach-location',
    menu_notes: null,
    happy_hour_notes: 'Thu. 11am-9pm Extended Happy Hour',
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://mrchubbyswings.com/ponte-vedra-beach-location',
      'official_thursday_extended_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Surfer the Bar',
    website: 'https://surferthebar.com/',
    phone: '(904) 372-9756',
    address: '200 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'Oceanfront Jax Beach bar with weekly specials and live energy on 1st Street North.',
    about_source: 'venue_website',
    hours_display: 'Mon closed · Tue–Fri 4pm–2am · Sat–Sun 11am–2am',
    hours_source: 'venue_website',
    menu_url: 'https://surferthebar.com/weekly-fun/',
    menu_notes: null,
    happy_hour_notes: 'Fri. 4-8pm half-price',
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://surferthebar.com/',
      'https://surferthebar.com/weekly-fun/',
    ]),
    happy_hour_menu_url: 'https://surferthebar.com/weekly-fun/',
  },
  {
    name: "Mango's Beach Bar & Grille",
    website: 'https://www.mangosjaxbeach.com/',
    phone: '(904) 246-4200',
    address: '602 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'Longtime Jacksonville Beach bar and grille with an outside deck on 1st Street.',
    about_source: 'venue_website',
    hours_display: 'Daily ~11am–2am',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: 'Daily 2-9pm',
    specials_notes: 'Official site says happy hour all day every day; schedule from aggregator',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.mangosjaxbeach.com/',
      'https://thehappyhourfinder.com/us_fl/jacksonville-beach/mangos-beach-bar-grille/',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: "Ginger's Place",
    website: 'https://www.gingers-place.net/',
    phone: '(904) 249-8711',
    address: '304 3rd St S, Jacksonville Beach, FL 32250',
    about_text: 'Neighborhood watering hole and decades-old Jacksonville Beach institution.',
    about_source: 'venue_listings',
    hours_display: 'Daily 1pm–2am',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.gingers-place.net/',
      'https://www.visitjacksonville.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Wreck Tiki Lounge',
    website: 'https://wrecktikilounge.com/',
    phone: '(904) 247-0507',
    address: '401 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'Tropical drinks, DJs, live music, and cornhole near the ocean in Jacksonville Beach.',
    about_source: 'venue_website',
    hours_display: 'See venue site — weekday evenings listed from 4pm',
    hours_source: 'venue_website',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: 'Shares 401 1st St N / (904) 247-0507 with Tavern on 1st listing history',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://wrecktikilounge.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Sandbar Jax Beach',
    website: 'https://www.jaxbeachsandbar.com/',
    phone: '(904) 246-6160',
    address: '465 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'Oceanfront cantina-style bar and grill at SpringHill Suites on 1st Street North.',
    about_source: 'venue_website',
    hours_display: 'Sun–Thu ~11am–10pm · Fri–Sat ~11am–11pm',
    hours_source: 'venue_website',
    menu_url: 'https://www.jaxbeachsandbar.com/event/happy-hour-br-monday-friday/',
    menu_notes: null,
    happy_hour_notes: 'Mon. - Fri. 2-5pm',
    specials_notes: '$4 wine/draft/cans + food specials (venue HH page)',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.jaxbeachsandbar.com/',
      'https://www.jaxbeachsandbar.com/event/happy-hour-br-monday-friday/',
    ]),
    happy_hour_menu_url: 'https://www.jaxbeachsandbar.com/event/happy-hour-br-monday-friday/',
  },
  {
    name: 'The Ritz Lounge',
    website: 'https://www.the-ritz-lounge.com/',
    phone: '(904) 246-2255',
    address: '185 3rd Ave N, Jacksonville Beach, FL 32250',
    about_text: 'Lounge on 3rd Avenue North in Jacksonville Beach.',
    about_source: 'venue_website',
    hours_display: 'Afternoons into late night (listings ~1pm–2am)',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.the-ritz-lounge.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: "Lucky's Bar",
    website: null,
    phone: '(904) 222-0796',
    address: '333 1st St N #150, Jacksonville Beach, FL 32250',
    about_text: 'Bar on 1st Street North in Jacksonville Beach (former Shim Sham space).',
    about_source: 'venue_listings',
    hours_display: 'Mon–Tue closed · Wed–Thu 5pm–2am · Fri–Sun 3pm–2am',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.visitjacksonville.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Tavern on 1st',
    website: null,
    phone: '(904) 247-0507',
    address: '401 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'Tavern listing at 401 1st St N — same address/phone as Wreck Tiki Lounge; kept as named Beaches directory entry.',
    about_source: 'venue_listings',
    hours_display: 'Mon–Fri 4pm–2am · Sat–Sun 1pm–2am',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: 'Possible rebrand overlap with Wreck Tiki Lounge',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'overpass:The Tavern on 1st Street',
      'https://www.visitjacksonville.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Salt Beachside Bar',
    website: null,
    phone: '(904) 241-2311',
    address: '1515 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'Oceanfront deck bar behind Hampton Inn Oceanfront (formerly Tides).',
    about_source: 'venue_listings',
    hours_display: 'Open until ~10pm (listings)',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'nominatim:1515-1st-st-n-hampton',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Flask & Cannon',
    website: 'https://www.vpizza.com/locations/jacksonville-beach-fl/',
    phone: '(904) 853-6633',
    address: '528 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'Neighborhood bar space at V Pizza Jacksonville Beach on 1st Street North.',
    about_source: 'venue_listings',
    hours_display: 'Mon–Thu 11am–10pm · Fri–Sat 11am–11pm · Sun 10am–9pm (listings; confirm on-site)',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.vpizza.com/locations/jacksonville-beach-fl/',
      'https://www.visitjacksonville.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Brix Taphouse & Bar',
    website: 'https://jacksonvillebeachbar.com/',
    phone: '(904) 241-4668',
    address: '300 2nd St N, Jacksonville Beach, FL 32250',
    about_text: 'Taphouse and bar in Jacksonville Beach on 2nd Street North.',
    about_source: 'venue_website',
    hours_display: 'Sun–Thu 11am–11pm · Fri–Sat 11am–12am',
    hours_source: 'venue_website',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://jacksonvillebeachbar.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: "Pusser's Bar and Grille",
    website: 'https://pusserspvb.com/',
    phone: '(904) 280-7766',
    address: '816 A1A N Suite 100, Ponte Vedra Beach, FL 32082',
    about_text: 'Tropical plates and Pusser’s Rum craft cocktails on the lakefront in Ponte Vedra Beach.',
    about_source: 'venue_website',
    hours_display: 'Sun–Thu 11am–9pm · Fri–Sat 11am–10pm',
    hours_source: 'venue_website',
    menu_url: 'https://pusserspvb.com/events/happy-hour/',
    menu_notes: null,
    happy_hour_notes: 'Mon. - Fri. 3:00-6:30pm',
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://pusserspvb.com/',
      'https://pusserspvb.com/events/happy-hour/',
      'coords:exa_30.201062_-81.381256',
    ]),
    happy_hour_menu_url: 'https://pusserspvb.com/events/happy-hour/',
  },
  {
    name: 'Jax Beach Bar & Grill',
    website: 'https://www.jaxbeachbarandgrill.com/',
    phone: '(904) 746-7774',
    address: '265 5th Ave N, Jacksonville Beach, FL 32250',
    about_text: 'Bar and grill on 5th Avenue North in Jacksonville Beach.',
    about_source: 'venue_website',
    hours_display: null,
    hours_source: null,
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.jaxbeachbarandgrill.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Kava & Co',
    website: 'https://kavaandcompany.com/',
    phone: '(904) 595-5150',
    address: '223 9th Ave S, Jacksonville Beach, FL 32250',
    about_text: 'Kava bar in Jacksonville Beach near 9th Avenue South and 3rd Street.',
    about_source: 'venue_website',
    hours_display: null,
    hours_source: null,
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://kavaandcompany.com/',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Factory After Dark',
    website: null,
    phone: '(904) 372-0366',
    address: '1396 Beach Blvd, Jacksonville Beach, FL 32250',
    about_text: 'Evening / nightlife bar venue on Beach Boulevard in Jacksonville Beach.',
    about_source: 'venue_listings',
    hours_display: null,
    hours_source: null,
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify(['venue_listings', 'no_confirmed_hh']),
    happy_hour_menu_url: null,
  },
  {
    name: 'LandShark Bar & Grill',
    website:
      'https://www.margaritavilleresorts.com/margaritaville-hotel-jacksonville-beach/eat-drink/landshark-bar-grill',
    phone: '(904) 222-0222',
    address: '715 1st St N, Jacksonville Beach, FL 32250',
    about_text: 'LandShark Bar & Grill inside Margaritaville Beach Hotel Jacksonville Beach.',
    about_source: 'venue_website',
    hours_display: null,
    hours_source: null,
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.margaritavilleresorts.com/margaritaville-hotel-jacksonville-beach/eat-drink/landshark-bar-grill',
      'no_confirmed_hh_jax_beach',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: "Monkey's Uncle Tavern",
    website: 'https://monkeysuncletavern.com/',
    phone: '(904) 246-1070',
    address: '1728 3rd St N, Jacksonville Beach, FL 32250',
    about_text: 'Beaches nightlife tavern since 1985 on 3rd Street North.',
    about_source: 'venue_website',
    hours_display: null,
    hours_source: null,
    menu_url: 'https://monkeysuncletavern.com/weekday-happy-hour-drink-specials/',
    menu_notes: null,
    happy_hour_notes: 'Mon. - Fri. 11am-7pm',
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://monkeysuncletavern.com/',
      'https://monkeysuncletavern.com/weekday-happy-hour-drink-specials/',
    ]),
    happy_hour_menu_url: 'https://monkeysuncletavern.com/weekday-happy-hour-drink-specials/',
  },
  {
    name: '1912 Ocean Bar & Rooftop',
    website: 'https://www.1912oceanbarandrooftop.com/',
    phone: '(904) 373-2063',
    address: '619 Ponte Vedra Blvd, Ponte Vedra Beach, FL 32082',
    about_text: 'Ocean bar and rooftop dining on Ponte Vedra Boulevard.',
    about_source: 'venue_website',
    hours_display: 'Mon–Sat 4–10pm · Sun brunch 11am–2pm',
    hours_source: 'venue_website',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: 'Mon. - Fri. 4-7pm',
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.1912oceanbarandrooftop.com/',
      'venue_hours_location_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Sneakers Sports Grille',
    website: 'https://sneakerssportsgrille.com/',
    phone: '(904) 482-1000',
    address: '111 Beach Blvd, Jacksonville Beach, FL 32250',
    about_text: 'Sports grille on Beach Boulevard in Jacksonville Beach.',
    about_source: 'venue_website',
    hours_display: 'Sun–Thu 11am–10pm · Fri–Sat 11am–12am',
    hours_source: 'venue_website',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: 'Daily 5-7pm',
    specials_notes: 'Aggregator also lists late Fri–Sat window — confirm on venue site',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://sneakerssportsgrille.com/',
      'https://thehappyhourfinder.com/us_fl/jacksonville-beach/sneaker-sports-grille/',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Green Room Brewing',
    website: 'https://greenroombrewing.com/',
    phone: '(904) 201-9283',
    address: '228 3rd St N, Jacksonville Beach, FL 32250',
    about_text: 'Local brewery with a dog-friendly patio in Jacksonville Beach.',
    about_source: 'venue_website',
    hours_display:
      'Mon closed · Tue–Thu 3pm–midnight · Fri 3pm–1am · Sat 12pm–1am · Sun 12pm–10pm',
    hours_source: 'venue_website',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://greenroombrewing.com/',
      'no_listed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Harbor Tavern',
    website: null,
    phone: '(904) 246-2555',
    address: '160 Mayport Rd, Atlantic Beach, FL 32233',
    about_text: 'Neighborhood tavern on Mayport Road in Atlantic Beach.',
    about_source: 'venue_listings',
    hours_display: 'Daily 11am–2am',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: 'Mon. - Fri. 4-7pm',
    specials_notes: '$1.50 domestic/wells — aggregator only; confirm on-site',
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://thehappyhourfinder.com/us_fl/atlantic-beach/harbor-tavern/',
      'nominatim:160-mayport-rd',
      'aggregator_hh_unconfirmed_on_official_site',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: 'Dragonfly Lounge',
    website: 'https://dragonflylounge-beaches.com/',
    phone: '(904) 903-7162',
    address: '1505 Atlantic Blvd #1537, Neptune Beach, FL 32266',
    about_text:
      'Craft mocktails and wellness-oriented beverages in Neptune Beach (Natural Dragonfly wellness lounge).',
    about_source: 'venue_website',
    hours_display:
      'Mon 11am–10pm · Tue closed · Wed–Thu 11am–10pm · Fri–Sat 11am–12am · Sun 11am–10pm',
    hours_source: 'venue_listings',
    menu_url: null,
    menu_notes: null,
    happy_hour_notes: null,
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://dragonflylounge-beaches.com/',
      'nominatim:1505-atlantic-blvd-neptune',
      'no_confirmed_hh',
    ]),
    happy_hour_menu_url: null,
  },
  {
    name: "Culhane's Irish Pub",
    website: 'https://www.culhanesirishpub.com/',
    phone: '(904) 249-9595',
    address: '967 Atlantic Blvd, Atlantic Beach, FL 32233',
    about_text: 'Irish pub in Atlantic Beach (Beaches location — not the Southside Culhane’s).',
    about_source: 'venue_website',
    hours_display:
      'Mon 11:30am–12am · Tue–Wed 11:30am–10pm · Thu 11:30am–12am · Fri 11:30am–1:30am · Sat 9am–1:30am · Sun 8:30am–12am',
    hours_source: 'venue_website',
    menu_url: 'https://www.culhanesirishpub.com/atlantic-beach-menu',
    menu_notes: null,
    happy_hour_notes: 'Mon. - Fri. 2-6pm\nFri. - Sat. 10pm-1am Late Night Happy Hour',
    specials_notes: null,
    enrichment_status: 'ok',
    enrichment_sources_json: JSON.stringify([
      'https://www.culhanesirishpub.com/',
      'https://www.culhanesirishpub.com/menus/happy-hour-flyer',
      'https://www.culhanesirishpub.com/atlantic-beach-menu',
      'nominatim:967-atlantic-blvd-ab',
    ]),
    happy_hour_menu_url: 'https://www.culhanesirishpub.com/menus/happy-hour-flyer',
  },
];

function patchDbJs() {
  const file = path.join(ROOT, 'lib', 'db.js');
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes("name: 'Dragonfly Lounge'")) {
    console.log('db.js already has Dragonfly — skip seed append');
    return;
  }
  const marker = "    osm_ref: 'address:150-valley-circle-pvb',\n  },\n];";
  if (!src.includes(marker)) {
    throw new Error('Could not find Chubby seed end marker in db.js');
  }
  const block = NEW_SEEDS.map((b) => {
    const phone = b.phone ? `\n    phone: ${JSON.stringify(b.phone)},` : '';
    return `  {
    name: ${JSON.stringify(b.name)},
    area: ${JSON.stringify(b.area)},
    category: ${JSON.stringify(b.category)},
    address: ${JSON.stringify(b.address)},${phone}
    lat: ${b.lat},
    lng: ${b.lng},
    hours_json: ${JSON.stringify(b.hours_json)},
    osm_ref: ${JSON.stringify(b.osm_ref)},
  }`;
  }).join(',\n');
  src = src.replace(marker, `    osm_ref: 'address:150-valley-circle-pvb',\n  },\n${block},\n];`);
  fs.writeFileSync(file, src);
  console.log(`db.js: appended ${NEW_SEEDS.length} seed venues`);
}

function patchLogosJs() {
  const file = path.join(ROOT, 'lib', 'logos.js');
  let src = fs.readFileSync(file, 'utf8');

  // Websites — insert before closing of KNOWN_WEBSITES
  if (!src.includes("'Dragonfly Lounge'")) {
    const webInsert = Object.entries(NEW_WEBSITES)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join('\n');
    src = src.replace(
      `  "Mr. Chubby's Wings": 'https://mrchubbyswings.com/ponte-vedra-beach-location',\n};`,
      `  "Mr. Chubby's Wings": 'https://mrchubbyswings.com/ponte-vedra-beach-location',\n${webInsert}\n};`
    );
  }

  if (!src.includes("'Dragonfly Lounge': '/assets/venues/dragonfly-lounge.png'")) {
    const logoInsert = Object.entries(NEW_OFFICIAL_LOGOS)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
      .join('\n');
    src = src.replace(
      `  "Mr. Chubby's Wings": '/assets/venues/mr-chubbys-wings.png',\n};`,
      `  "Mr. Chubby's Wings": '/assets/venues/mr-chubbys-wings.png',\n${logoInsert}\n};`
    );
  }

  fs.writeFileSync(file, src);
  console.log(`logos.js: +${Object.keys(NEW_WEBSITES).length} websites, +${Object.keys(NEW_OFFICIAL_LOGOS).length} official logos`);
}

function rebuildEnrichmentCache() {
  const file = path.join(ROOT, 'data', 'enrichment-cache.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byName = new Map();
  for (const v of cache.venues || []) {
    if (v.name === "Fly's Tie Irish Pub") continue;
    byName.set(v.name, v);
  }
  for (const v of NEW_ENRICHMENT) {
    byName.set(v.name, {
      ...v,
      slug: slugify(v.name),
      website: v.website || '',
      phone: v.phone || '',
    });
  }
  const venues = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = {
    updated_at: new Date().toISOString(),
    venues,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`enrichment-cache.json: ${venues.length} venues (Fly's Tie removed)`);
}

function bumpSw() {
  const file = path.join(ROOT, 'public', 'sw.js');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/ongo-shell-v\d+/, 'ongo-shell-v13');
  fs.writeFileSync(file, src);
  console.log('sw.js → ongo-shell-v13');
}

function stripFlysTieFromOverpass() {
  const file = path.join(ROOT, 'data', 'overpass-beaches.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = Array.isArray(data) ? data.length : (data.elements || data.venues || []).length;
  let arr;
  let key = null;
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.elements)) {
    arr = data.elements;
    key = 'elements';
  } else if (Array.isArray(data.venues)) {
    arr = data.venues;
    key = 'venues';
  } else return;
  const filtered = arr.filter((x) => {
    const n = x.name || x.tags?.name || '';
    return !/fly'?s\s*tie/i.test(n);
  });
  if (key) data[key] = filtered;
  else {
    fs.writeFileSync(file, JSON.stringify(filtered, null, 2) + '\n');
    console.log(`overpass-beaches.json: ${before} → ${filtered.length}`);
    return;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`overpass-beaches.json: ${before} → ${filtered.length}`);
}

function writeDocsSnippet() {
  const docsDir = path.join(ROOT, '..', 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const lines = [
    '# Beaches venue batch — addresses & sources',
    '',
    `Updated: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '| Venue | Address | Lat/Lng | HH | Notes |',
    '|---|---|---|---|---|',
  ];
  for (const b of NEW_SEEDS) {
    const e = NEW_ENRICHMENT.find((x) => x.name === b.name);
    lines.push(
      `| ${b.name} | ${b.address} | ${b.lat}, ${b.lng} | ${e?.happy_hour_notes || '—'} | ${b.osm_ref} |`
    );
  }
  lines.push('');
  lines.push('Dragonfly Lounge address verified via Nominatim house pin at 1505 Atlantic Blvd, Neptune Beach.');
  lines.push("Culhane's Irish Pub (Beaches) address verified via Nominatim at 967 Atlantic Blvd, Atlantic Beach — Southside location excluded.");
  lines.push('');
  fs.writeFileSync(path.join(docsDir, 'venue-coords.md'), lines.join('\n'));
  console.log('docs/venue-coords.md updated');
}

patchDbJs();
patchLogosJs();
rebuildEnrichmentCache();
bumpSw();
stripFlysTieFromOverpass();
writeDocsSnippet();
console.log('Done.');
