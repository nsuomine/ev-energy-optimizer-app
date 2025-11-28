const API_ENDPOINTS = [
  'https://api.spot-hinta.fi/TodayAndDayForward',
  'https://api.spot-hinta.fi/DayForward',
  'https://api.spot-hinta.fi/Today'
];
const PRICING_BASE_URL = new URL('../config/pricing/', import.meta.url);
const PRICING_MANIFEST_URL = new URL('manifest.json', PRICING_BASE_URL).href;

const MINUTES_IN_DAY = 24 * 60;
const DAY_NAME_TO_INDEX = {
  sun: 0,
  sunday: 0,
  ma: 1,
  mon: 1,
  monday: 1,
  ti: 2,
  tue: 2,
  tuesday: 2,
  ke: 3,
  wed: 3,
  wednesday: 3,
  to: 4,
  thu: 4,
  thursday: 4,
  pe: 5,
  fri: 5,
  friday: 5,
  la: 6,
  sat: 6,
  saturday: 6
};

function resolveStartTime(entry) {
  const candidate =
    entry.startTime ??
    entry.start_time ??
    entry.startDate ??
    entry.start_date ??
    entry.startDateTime ??
    entry.start_date_time ??
    entry.dateTime ??
    entry.DateTime ??
    entry.time ??
    entry.timestamp ??
    entry.Timestamp ??
    entry.hourUTC ??
    entry.hour_local ??
    null;

  if (candidate && typeof candidate === 'number') {
    return new Date(candidate).toISOString();
  }

  return candidate;
}

function resolvePrice(entry) {
  const candidates = [
    entry.price,
    entry.priceEurMwh,
    entry.price_eur_mwh,
    entry.priceEurMWh,
    entry.price_cents,
    entry.priceCents,
    entry.value,
    entry.unitPrice,
    entry.unit_price,
    entry.Price,
    entry.PriceWithTax,
    entry.PriceWithoutTax,
    entry.priceWithTax,
    entry.priceWithoutTax
  ];

  let raw = candidates.find((val) => val !== undefined && val !== null);

  if (raw === undefined) {
    return null;
  }

  let price = Number(raw);

  if (Number.isNaN(price)) {
    return null;
  }

  const unit = (entry.unit || entry.priceUnit || '').toLowerCase();

  if (unit.includes('eur/mwh') || unit.includes('€/mwh')) {
    return price / 1000;
  }

  if (unit.includes('c/kwh')) {
    return price / 100;
  }

  if (price > 500) {
    return price / 1000;
  }

  if (price > 9) {
    return price / 100;
  }

  return price;
}

function parsePricePayload(payload) {
  if (!payload) {
    return [];
  }

  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.prices)
    ? payload.prices
    : Array.isArray(payload.data)
    ? payload.data
    : [];

  const parsed = entries
    .map((entry, index) => {
      const price = resolvePrice(entry);
      const startTime = resolveStartTime(entry);

      if (price === null || !startTime) {
        return null;
      }

      return { startTime, price };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  return parsed;
}

export async function fetchSpotPrices() {
  let lastError = null;

  for (const endpoint of API_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });

      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        console.warn(`Spot price request failed for ${endpoint}: HTTP ${response.status}`);
        continue;
      }

      const payload = await response.json();
      const parsed = parsePricePayload(payload);

      if (parsed.length > 0) {
        return parsed;
      }

      lastError = new Error('Empty price payload');
      console.warn(`Spot price request failed for ${endpoint}: empty payload`);
    } catch (error) {
      lastError = error;
      console.warn(`Spot price request failed for ${endpoint}:`, error);
    }
  }

  const error = new Error('Failed to load spot price data');
  error.cause = lastError;
  throw error;
}

export const defaultCostConfiguration = {
  siirto: {
    unit: 'EUR_PER_KWH',
    tiers: []
  },
  teho: {
    unit: 'EUR_PER_KW',
    tiers: []
  }
};

function cloneIntervals(intervals) {
  return (intervals || []).map((interval) => ({
    startMinutes: interval.startMinutes,
    endMinutes: interval.endMinutes,
    days: Array.isArray(interval.days) ? [...interval.days] : []
  }));
}

function cloneTiers(tiers) {
  return (tiers || []).map((tier) => ({
    id: typeof tier.id === 'string' ? tier.id : undefined,
    rate: tier.rate,
    startDate: tier.startDate,
    endDate: tier.endDate,
    weekdays: Array.isArray(tier.weekdays) ? [...tier.weekdays] : [],
    intervals: cloneIntervals(tier.intervals)
  }));
}

function cloneCostConfiguration(source) {
  return {
    siirto: {
      unit: source?.siirto?.unit || defaultCostConfiguration.siirto.unit,
      tiers: cloneTiers(source?.siirto?.tiers)
    },
    teho: {
      unit: source?.teho?.unit || defaultCostConfiguration.teho.unit,
      tiers: cloneTiers(source?.teho?.tiers)
    }
  };
}

function normalizePricingEntry(entry, index, errors) {
  if (!entry || typeof entry !== 'object') {
    if (errors) {
      errors.push(`Hinnaston valikko: määrittely ${index + 1} puuttuu.`);
    }
    return null;
  }

  const rawId = typeof entry.id === 'string' ? entry.id.trim() : '';

  if (!rawId) {
    if (errors) {
      errors.push(`Hinnaston valikko: kohteen ${index + 1} tunniste puuttuu.`);
    }
    return null;
  }

  const rawName = typeof entry.name === 'string' ? entry.name.trim() : '';

  if (!rawName) {
    if (errors) {
      errors.push(`Hinnaston valikko: kohteen ${rawId} nimi puuttuu.`);
    }
    return null;
  }

  const rawPath =
    typeof entry.configPath === 'string'
      ? entry.configPath.trim()
      : typeof entry.config === 'string'
      ? entry.config.trim()
      : typeof entry.file === 'string'
      ? entry.file.trim()
      : '';

  if (!rawPath) {
    if (errors) {
      errors.push(`Hinnaston valikko: kohteen ${rawId} konfiguraatiopolku puuttuu.`);
    }
    return null;
  }

  return {
    id: rawId,
    name: rawName,
    configPath: rawPath
  };
}

function parsePricingManifest(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Hinnaston valikko ei ole saatavilla: rakenne puuttuu.');
  }

  const errors = [];
  const rawEntries = Array.isArray(payload.pricings) ? payload.pricings : [];
  const entries = rawEntries
    .map((entry, index) => normalizePricingEntry(entry, index, errors))
    .filter(Boolean);

  if (!entries.length) {
    errors.push('Hinnaston valikko: hinnoitteluita ei ole määritelty.');
  }

  const defaultId =
    typeof payload.default === 'string' && payload.default.trim()
      ? payload.default.trim()
      : entries[0]?.id || '';

  if (!defaultId) {
    errors.push('Hinnaston valikko: oletushinnoittelu puuttuu.');
  }

  if (errors.length) {
    const error = new Error(`Hinnaston valikon lataus epäonnistui: ${errors.join(' ')}`);
    error.details = errors;
    throw error;
  }

  return {
    defaultId,
    pricings: entries
  };
}

export async function fetchPricingManifest() {
  const response = await fetch(PRICING_MANIFEST_URL, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Hinnaston valikon haku epäonnistui: HTTP ${response.status}`);
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('Hinnaston valikon haku epäonnistui: JSON-rakenne on virheellinen.');
  }

  return parsePricingManifest(payload);
}

function resolveConfigUrl(source) {
  const normalize = (path) => {
    if (!path || typeof path !== 'string') {
      return '';
    }

    const trimmed = path.trim();

    if (!trimmed) {
      return '';
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    try {
      return new URL(trimmed, PRICING_BASE_URL).href;
    } catch (error) {
      console.warn('Hinnoittelupolun muodostus epäonnistui:', error);
      return '';
    }
  };

  if (typeof source === 'string') {
    return normalize(source);
  }

  if (source && typeof source === 'object') {
    if (typeof source.configPath === 'string') {
      return normalize(source.configPath.trim());
    }

    if (typeof source.config === 'string') {
      return normalize(source.config.trim());
    }

    if (typeof source.file === 'string') {
      return normalize(source.file.trim());
    }
  }

  return new URL('helen.json', PRICING_BASE_URL).href;
}

function parseTimeValue(value, { context, label, errors } = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0 || value > 24) {
      if (errors && context && label) {
        errors.push(`${context}: ${label} aika on virheellinen (${value}).`);
      }
      return null;
    }

    return Math.round(value * 60);
  }

  if (typeof value !== 'string') {
    if (errors && context && label) {
      errors.push(`${context}: ${label} aikaa ei ole määritelty.`);
    }
    return null;
  }

  const trimmed = value.trim();

  if (!/^[0-2]?\d:[0-5]\d$/.test(trimmed) && !/^[0-2]?\d$/.test(trimmed)) {
    if (errors && context && label) {
      errors.push(`${context}: ${label} aika on virheellinen (${value}).`);
    }
    return null;
  }

  const [hoursPart, minutesPart] = trimmed.split(':');
  const hours = Number(hoursPart);
  const minutes = minutesPart !== undefined ? Number(minutesPart) : 0;

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    if (errors && context && label) {
      errors.push(`${context}: ${label} aika on virheellinen (${value}).`);
    }
    return null;
  }

  if (hours < 0 || hours > 24) {
    if (errors && context && label) {
      errors.push(`${context}: ${label} aika on virheellinen (${value}).`);
    }
    return null;
  }

  if (minutes < 0 || minutes >= 60) {
    if (errors && context && label) {
      errors.push(`${context}: ${label} aika on virheellinen (${value}).`);
    }
    return null;
  }

  const total = hours * 60 + minutes;

  if (total > MINUTES_IN_DAY) {
    if (errors && context && label) {
      errors.push(`${context}: ${label} aika on virheellinen (${value}).`);
    }
    return null;
  }

  return total;
}

function normalizeDays(input) {
  if (!input) {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
    ? input
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    : [input];
  const normalized = new Set();

  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) {
      normalized.add(value);
      continue;
    }

    if (typeof value !== 'string') {
      continue;
    }

    const lower = value.trim().toLowerCase();

    if (lower === 'weekday' || lower === 'weekdays') {
      [1, 2, 3, 4, 5].forEach((day) => normalized.add(day));
      continue;
    }

    if (lower === 'weekend' || lower === 'weekends') {
      [0, 6].forEach((day) => normalized.add(day));
      continue;
    }

    const mapped = DAY_NAME_TO_INDEX[lower];

    if (mapped !== undefined) {
      normalized.add(mapped);
    }
  }

  if (!normalized.size) {
    return [0, 1, 2, 3, 4, 5, 6];
  }

  return Array.from(normalized).sort((a, b) => a - b);
}

function normalizeIntervalDefinition(definition, context, errors) {
  if (!definition || typeof definition !== 'object') {
    if (errors) {
      errors.push(`${context}: aikaväli puuttuu tai on virheellinen.`);
    }
    return [];
  }

  const rawStart = definition.start ?? definition.startTime ?? definition.from ?? definition.begin;
  const rawEnd = definition.end ?? definition.endTime ?? definition.to ?? definition.finish;

  const startMinutes = parseTimeValue(rawStart, { context, label: 'alku', errors });
  const endMinutes = parseTimeValue(rawEnd, { context, label: 'loppu', errors });

  if (startMinutes === null || endMinutes === null) {
    return [];
  }

  const days = normalizeDays(
    definition.days ?? definition.day ?? definition.weekdays ?? definition.dayOfWeek
  );

  if (startMinutes === endMinutes) {
    return [
      {
        startMinutes: 0,
        endMinutes: MINUTES_IN_DAY,
        days
      }
    ];
  }

  if (startMinutes < endMinutes) {
    return [
      {
        startMinutes,
        endMinutes,
        days
      }
    ];
  }

  return [
    {
      startMinutes,
      endMinutes: MINUTES_IN_DAY,
      days
    },
    {
      startMinutes: 0,
      endMinutes,
      days
    }
  ];
}

function parseTierWeekdays(rawWeekdays, context, errors) {
  const values = Array.isArray(rawWeekdays)
    ? rawWeekdays
    : typeof rawWeekdays === 'string'
    ? rawWeekdays
        .split(/[\s,;]+/)
        .map((value) => value.trim())
        .filter(Boolean)
    : [rawWeekdays];

  const normalized = new Set();
  let sawValid = false;

  for (const value of values) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const numberValue = Number(value);

    if (Number.isInteger(numberValue) && numberValue >= 0 && numberValue <= 6) {
      normalized.add(numberValue);
      sawValid = true;
      continue;
    }

    if (typeof value === 'string') {
      const mapped = DAY_NAME_TO_INDEX[value.trim().toLowerCase()];

      if (mapped !== undefined) {
        normalized.add(mapped);
        sawValid = true;
        continue;
      }
    }

    if (errors) {
      errors.push(`${context}: viikonpäivä ${String(value)} on virheellinen.`);
    }
  }

  const result = Array.from(normalized).sort((a, b) => a - b);

  if (!sawValid || !result.length) {
    if (errors) {
      errors.push(`${context}: viikonpäiviä ei ole määritelty.`);
    }
    return [];
  }

  return result;
}

function normalizeTier(tierDefinition, branchName, index, errors) {
  if (!tierDefinition || typeof tierDefinition !== 'object') {
    if (errors) {
      errors.push(`${branchName} tason ${index + 1} määrittely puuttuu.`);
    }
    return null;
  }

  const label = tierDefinition.id || tierDefinition.name || `#${index + 1}`;
  const context = `${branchName} (${label})`;

  const rateCandidate =
    tierDefinition.rate ?? tierDefinition.value ?? tierDefinition.price ?? tierDefinition.amount;
  const rate = Number(rateCandidate);

  if (!Number.isFinite(rate) || rate < 0) {
    if (errors) {
      errors.push(`${context}: hinta on virheellinen (${String(rateCandidate)}).`);
    }
    return null;
  }

  const startDateRaw =
    tierDefinition.startDate ??
    tierDefinition.start_date ??
    tierDefinition.start ??
    tierDefinition.validFrom;
  const endDateRaw =
    tierDefinition.endDate ?? tierDefinition.end_date ?? tierDefinition.end ?? tierDefinition.validUntil;

  const startDate = typeof startDateRaw === 'string' ? startDateRaw.trim() : null;
  const endDate = typeof endDateRaw === 'string' ? endDateRaw.trim() : null;

  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    if (errors) {
      errors.push(`${context}: alkupäivä puuttuu tai on virheellinen.`);
    }
    return null;
  }

  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    if (errors) {
      errors.push(`${context}: loppupäivä puuttuu tai on virheellinen.`);
    }
    return null;
  }

  if (startDate > endDate) {
    if (errors) {
      errors.push(`${context}: alkupäivä on loppupäivää myöhäisempi.`);
    }
    return null;
  }

  const weekdays = parseTierWeekdays(
    tierDefinition.weekdays ?? tierDefinition.days ?? tierDefinition.dayOfWeek,
    context,
    errors
  );

  if (!weekdays.length) {
    return null;
  }

  const intervalsDefinition = Array.isArray(tierDefinition.intervals)
    ? tierDefinition.intervals
    : [];
  const normalizedIntervals = intervalsDefinition
    .flatMap((interval, intervalIndex) =>
      normalizeIntervalDefinition(interval, `${context} aikaväli ${intervalIndex + 1}`, errors)
    )
    .filter((interval) => interval.endMinutes > interval.startMinutes);

  if (!normalizedIntervals.length) {
    if (errors) {
      errors.push(`${context}: aikavälit puuttuvat.`);
    }
    return null;
  }

  return {
    id: typeof tierDefinition.id === 'string' ? tierDefinition.id : undefined,
    rate,
    startDate,
    endDate,
    weekdays,
    intervals: normalizedIntervals
  };
}

function parseUsageConfiguration(branchUsage) {
  return Object.entries(branchUsage && typeof branchUsage === 'object' ? branchUsage : {}).reduce(
    (acc, [dateKey, value]) => {
      if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        return acc;
      }

      let apply = true;
      let rate = null;

      if (typeof value === 'boolean') {
        apply = value;
      } else if (typeof value === 'number') {
        rate = Number(value);
      } else if (value && typeof value === 'object') {
        if (value.apply !== undefined) {
          apply = Boolean(value.apply);
        }

        const rateCandidate =
          value.rate ?? value.value ?? value.amount ?? value.price ?? value.ratePerKw ?? value.rate_per_kw;

        if (rateCandidate !== undefined && Number.isFinite(Number(rateCandidate))) {
          rate = Number(rateCandidate);
        }
      }

      acc[dateKey] = {
        apply,
        rate: Number.isFinite(rate) ? rate : null
      };

      return acc;
    },
    {}
  );
}

function parseCostConfiguration(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Hinnaston lataus epäonnistui: rakenne puuttuu.');
  }

  const errors = [];

  const parseBranch = (branch, branchName, { optional = false } = {}) => {
    if (!branch || typeof branch !== 'object') {
      if (!optional) {
        errors.push(`${branchName}: konfiguraatio puuttuu.`);
      }
      return {
        unit: defaultCostConfiguration[branchName]?.unit,
        tiers: []
      };
    }

    const unit = typeof branch.unit === 'string' ? branch.unit : defaultCostConfiguration[branchName]?.unit;
    const rawTiers = Array.isArray(branch.tiers) ? [...branch.tiers] : [];

    const tiers = rawTiers
      .map((tier, index) => normalizeTier(tier, branchName, index, errors))
      .filter((tier) => tier !== null);

    if (!tiers.length && !optional) {
      errors.push(`${branchName}: hinnoittelutasot puuttuvat.`);
    }

    return {
      unit,
      tiers
    };
  };

  const result = {
    siirto: parseBranch(payload.siirto || {}, 'siirto'),
    teho: parseBranch(payload.teho || {}, 'teho', { optional: true })
  };

  if (errors.length) {
    const error = new Error(`Hinnaston lataus epäonnistui: ${errors.join(' ')}`);
    error.details = errors;
    throw error;
  }

  return result;
}

export async function fetchCostConfiguration(source) {
  const configUrl = resolveConfigUrl(source);
  const response = await fetch(configUrl, { cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Hinnaston haku epäonnistui: HTTP ${response.status}`);
  }

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('Hinnaston haku epäonnistui: JSON-rakenne on virheellinen.');
  }

  return cloneCostConfiguration(parseCostConfiguration(payload));
}
