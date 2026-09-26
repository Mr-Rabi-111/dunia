/**
 * Shared reference data — imported by BOTH the Node server and the browser
 * (served at /shared/data.js). Keep it dependency-free ES module syntax.
 *
 * Country names shown to users come from Intl.DisplayNames in the user's own
 * language; the English names here are only a fallback and a search alias.
 */

// [ISO 3166-1 alpha-2, English name, continent]
// Continents: AF Africa, AS Asia, EU Europe, NA North America, OC Oceania, SA South America
export const COUNTRIES = [
  ['AF','Afghanistan','AS'],['AL','Albania','EU'],['DZ','Algeria','AF'],['AD','Andorra','EU'],
  ['AO','Angola','AF'],['AG','Antigua and Barbuda','NA'],['AR','Argentina','SA'],['AM','Armenia','AS'],
  ['AU','Australia','OC'],['AT','Austria','EU'],['AZ','Azerbaijan','AS'],['BS','Bahamas','NA'],
  ['BH','Bahrain','AS'],['BD','Bangladesh','AS'],['BB','Barbados','NA'],['BY','Belarus','EU'],
  ['BE','Belgium','EU'],['BZ','Belize','NA'],['BJ','Benin','AF'],['BT','Bhutan','AS'],
  ['BO','Bolivia','SA'],['BA','Bosnia and Herzegovina','EU'],['BW','Botswana','AF'],['BR','Brazil','SA'],
  ['BN','Brunei','AS'],['BG','Bulgaria','EU'],['BF','Burkina Faso','AF'],['BI','Burundi','AF'],
  ['KH','Cambodia','AS'],['CM','Cameroon','AF'],['CA','Canada','NA'],['CV','Cape Verde','AF'],
  ['CF','Central African Republic','AF'],['TD','Chad','AF'],['CL','Chile','SA'],['CN','China','AS'],
  ['CO','Colombia','SA'],['KM','Comoros','AF'],['CG','Congo','AF'],['CD','Congo (DRC)','AF'],
  ['CR','Costa Rica','NA'],['CI','Côte d’Ivoire','AF'],['HR','Croatia','EU'],['CU','Cuba','NA'],
  ['CY','Cyprus','EU'],['CZ','Czechia','EU'],['DK','Denmark','EU'],['DJ','Djibouti','AF'],
  ['DM','Dominica','NA'],['DO','Dominican Republic','NA'],['EC','Ecuador','SA'],['EG','Egypt','AF'],
  ['SV','El Salvador','NA'],['GQ','Equatorial Guinea','AF'],['ER','Eritrea','AF'],['EE','Estonia','EU'],
  ['SZ','Eswatini','AF'],['ET','Ethiopia','AF'],['FJ','Fiji','OC'],['FI','Finland','EU'],
  ['FR','France','EU'],['GA','Gabon','AF'],['GM','Gambia','AF'],['GE','Georgia','AS'],
  ['DE','Germany','EU'],['GH','Ghana','AF'],['GR','Greece','EU'],['GD','Grenada','NA'],
  ['GT','Guatemala','NA'],['GN','Guinea','AF'],['GW','Guinea-Bissau','AF'],['GY','Guyana','SA'],
  ['HT','Haiti','NA'],['HN','Honduras','NA'],['HK','Hong Kong','AS'],['HU','Hungary','EU'],
  ['IS','Iceland','EU'],['IN','India','AS'],['ID','Indonesia','AS'],['IR','Iran','AS'],
  ['IQ','Iraq','AS'],['IE','Ireland','EU'],['IL','Israel','AS'],['IT','Italy','EU'],
  ['JM','Jamaica','NA'],['JP','Japan','AS'],['JO','Jordan','AS'],['KZ','Kazakhstan','AS'],
  ['KE','Kenya','AF'],['KI','Kiribati','OC'],['XK','Kosovo','EU'],['KW','Kuwait','AS'],
  ['KG','Kyrgyzstan','AS'],['LA','Laos','AS'],['LV','Latvia','EU'],['LB','Lebanon','AS'],
  ['LS','Lesotho','AF'],['LR','Liberia','AF'],['LY','Libya','AF'],['LI','Liechtenstein','EU'],
  ['LT','Lithuania','EU'],['LU','Luxembourg','EU'],['MO','Macao','AS'],['MG','Madagascar','AF'],
  ['MW','Malawi','AF'],['MY','Malaysia','AS'],['MV','Maldives','AS'],['ML','Mali','AF'],
  ['MT','Malta','EU'],['MH','Marshall Islands','OC'],['MR','Mauritania','AF'],['MU','Mauritius','AF'],
  ['MX','Mexico','NA'],['FM','Micronesia','OC'],['MD','Moldova','EU'],['MC','Monaco','EU'],
  ['MN','Mongolia','AS'],['ME','Montenegro','EU'],['MA','Morocco','AF'],['MZ','Mozambique','AF'],
  ['MM','Myanmar','AS'],['NA','Namibia','AF'],['NR','Nauru','OC'],['NP','Nepal','AS'],
  ['NL','Netherlands','EU'],['NZ','New Zealand','OC'],['NI','Nicaragua','NA'],['NE','Niger','AF'],
  ['NG','Nigeria','AF'],['KP','North Korea','AS'],['MK','North Macedonia','EU'],['NO','Norway','EU'],
  ['OM','Oman','AS'],['PK','Pakistan','AS'],['PW','Palau','OC'],['PS','Palestine','AS'],
  ['PA','Panama','NA'],['PG','Papua New Guinea','OC'],['PY','Paraguay','SA'],['PE','Peru','SA'],
  ['PH','Philippines','AS'],['PL','Poland','EU'],['PT','Portugal','EU'],['PR','Puerto Rico','NA'],
  ['QA','Qatar','AS'],['RE','Réunion','AF'],['RO','Romania','EU'],['RU','Russia','EU'],
  ['RW','Rwanda','AF'],['KN','Saint Kitts and Nevis','NA'],['LC','Saint Lucia','NA'],
  ['VC','Saint Vincent and the Grenadines','NA'],['WS','Samoa','OC'],['SM','San Marino','EU'],
  ['ST','São Tomé and Príncipe','AF'],['SA','Saudi Arabia','AS'],['SN','Senegal','AF'],['RS','Serbia','EU'],
  ['SC','Seychelles','AF'],['SL','Sierra Leone','AF'],['SG','Singapore','AS'],['SK','Slovakia','EU'],
  ['SI','Slovenia','EU'],['SB','Solomon Islands','OC'],['SO','Somalia','AF'],['ZA','South Africa','AF'],
  ['KR','South Korea','AS'],['SS','South Sudan','AF'],['ES','Spain','EU'],['LK','Sri Lanka','AS'],
  ['SD','Sudan','AF'],['SR','Suriname','SA'],['SE','Sweden','EU'],['CH','Switzerland','EU'],
  ['SY','Syria','AS'],['TW','Taiwan','AS'],['TJ','Tajikistan','AS'],['TZ','Tanzania','AF'],
  ['TH','Thailand','AS'],['TL','Timor-Leste','AS'],['TG','Togo','AF'],['TO','Tonga','OC'],
  ['TT','Trinidad and Tobago','NA'],['TN','Tunisia','AF'],['TR','Türkiye','AS'],['TM','Turkmenistan','AS'],
  ['TV','Tuvalu','OC'],['UG','Uganda','AF'],['UA','Ukraine','EU'],['AE','United Arab Emirates','AS'],
  ['GB','United Kingdom','EU'],['US','United States','NA'],['UY','Uruguay','SA'],['UZ','Uzbekistan','AS'],
  ['VU','Vanuatu','OC'],['VA','Vatican City','EU'],['VE','Venezuela','SA'],['VN','Vietnam','AS'],
  ['YE','Yemen','AS'],['ZM','Zambia','AF'],['ZW','Zimbabwe','AF'],
];

export const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c[0]));
export const CONTINENT_OF = Object.fromEntries(COUNTRIES.map((c) => [c[0], c[2]]));
export const COUNTRY_EN = Object.fromEntries(COUNTRIES.map((c) => [c[0], c[1]]));

// Languages people can say they SPEAK (used for matching). [BCP-47 code, native name]
export const SPOKEN_LANGUAGES = [
  ['en','English'],['es','Español'],['pt','Português'],['fr','Français'],['de','Deutsch'],
  ['it','Italiano'],['nl','Nederlands'],['ru','Русский'],['uk','Українська'],['pl','Polski'],
  ['ro','Română'],['el','Ελληνικά'],['tr','Türkçe'],['ar','العربية'],['fa','فارسی'],
  ['he','עברית'],['ur','اردو'],['hi','हिन्दी'],['bn','বাংলা'],['pa','ਪੰਜਾਬੀ'],
  ['gu','ગુજરાતી'],['mr','मराठी'],['ta','தமிழ்'],['te','తెలుగు'],['kn','ಕನ್ನಡ'],
  ['ml','മലയാളം'],['ne','नेपाली'],['si','සිංහල'],['id','Bahasa Indonesia'],['ms','Bahasa Melayu'],
  ['fil','Filipino'],['vi','Tiếng Việt'],['th','ไทย'],['my','မြန်မာ'],['km','ខ្មែរ'],
  ['zh','中文'],['ja','日本語'],['ko','한국어'],['sw','Kiswahili'],['am','አማርኛ'],
  ['ha','Hausa'],['yo','Yorùbá'],['zu','isiZulu'],['sv','Svenska'],['no','Norsk'],
  ['da','Dansk'],['fi','Suomi'],['cs','Čeština'],['hu','Magyar'],['sr','Српски'],
  ['hr','Hrvatski'],['bg','Български'],['az','Azərbaycan'],['kk','Қазақ'],['uz','Oʻzbek'],
];
export const SPOKEN_CODES = new Set(SPOKEN_LANGUAGES.map((l) => l[0]));

// Interface languages that ship with translations. [code, native name, direction]
export const UI_LOCALES = [
  ['en','English','ltr'],['es','Español','ltr'],['pt','Português','ltr'],['fr','Français','ltr'],
  ['de','Deutsch','ltr'],['it','Italiano','ltr'],['ru','Русский','ltr'],['tr','Türkçe','ltr'],
  ['ar','العربية','rtl'],['ur','اردو','rtl'],['hi','हिन्दी','ltr'],['bn','বাংলা','ltr'],
  ['ta','தமிழ்','ltr'],['id','Bahasa Indonesia','ltr'],['vi','Tiếng Việt','ltr'],['th','ไทย','ltr'],
  ['ja','日本語','ltr'],['ko','한국어','ltr'],['zh','简体中文','ltr'],['fil','Filipino','ltr'],
];

// Interests are canonical IDs, not free text, so "Música" (es) and "संगीत" (hi)
// match each other. Labels are translated in /locales/*.json as interest.<id>.
export const INTERESTS = [
  'music','movies','gaming','sports','travel','food',
  'tech','art','books','anime','fitness','languages',
];

export const GENDERS = ['male', 'female'];

export const REPORT_REASONS = {
  // weight feeds the auto-restriction score; ipBan = severe enough to also
  // restrict the IP address (see docs/SAFETY.md for the CGNAT caveat)
  underage:   { weight: 3, ipBan: true },
  sexual:     { weight: 2, ipBan: true },
  violence:   { weight: 2, ipBan: false },
  hate:       { weight: 2, ipBan: false },
  harassment: { weight: 1, ipBan: false },
  spam:       { weight: 1, ipBan: false },
  fake:       { weight: 1, ipBan: false },
};

export const REACTIONS = ['👋', '😂', '❤️', '👍', '🔥', '😮'];
