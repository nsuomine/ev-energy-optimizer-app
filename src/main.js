import React from 'https://esm.sh/react@18.2.0';
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client';
import {
  fetchSpotPrices,
  fetchCostConfiguration,
  fetchPricingManifest,
  defaultCostConfiguration
} from './priceService.js';

const { useState, useEffect, useMemo } = React;
const h = React.createElement;

const timeFormatter = new Intl.DateTimeFormat('fi-FI', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit'
});

const dateFormatter = new Intl.DateTimeFormat('fi-FI', {
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit'
});

const currencyFormatter = new Intl.NumberFormat('fi-FI', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const priceFormatter = new Intl.NumberFormat('fi-FI', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3
});

const marginFormatter = new Intl.NumberFormat('fi-FI', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const powerFormatter = new Intl.NumberFormat('fi-FI', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

const FULL_CHARGE_FACTOR = 0.85;
const HOUR_IN_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'lataaja.settings';
const DEFAULT_CHARGING_POWER = 11;
const DEFAULT_ENERGY_AMOUNT = 45;
const DEFAULT_TEHO_MODE = 'ignore';
const DEFAULT_FULL_CHARGE = false;
const DEFAULT_ELECTRICITY_MARGIN = 0.003;
const CHARGING_POWER_RANGE = { min: 3, max: 22 };
const ENERGY_AMOUNT_RANGE = { min: 5, max: 120 };
const ELECTRICITY_MARGIN_RANGE = { min: 0, max: 0.0056 };
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const SAHKOVERO_RATE_PER_KWH = 0.027;

function clampValue(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, min), max);
}

function normalizeChargingPower(value) {
  return clampValue(Number(value), CHARGING_POWER_RANGE.min, CHARGING_POWER_RANGE.max, DEFAULT_CHARGING_POWER);
}

function normalizeEnergyAmount(value) {
  return clampValue(Number(value), ENERGY_AMOUNT_RANGE.min, ENERGY_AMOUNT_RANGE.max, DEFAULT_ENERGY_AMOUNT);
}

function normalizeElectricityMargin(value) {
  return clampValue(
    Number(value),
    ELECTRICITY_MARGIN_RANGE.min,
    ELECTRICITY_MARGIN_RANGE.max,
    DEFAULT_ELECTRICITY_MARGIN
  );
}

function isValidTehoMode(value) {
  return value === 'include' || value === 'ignore';
}

function loadStoredSettings() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn('Stored settings load failed:', error);
    return null;
  }
}

function persistSettings(settings) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn('Stored settings save failed:', error);
    return false;
  }
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function calculateTehoMetrics(portions, chargingPower, resolveTehoUsage) {
  if (!Array.isArray(portions) || !portions.length || !(chargingPower > 0)) {
    return {
      cost: 0,
      maxAveragePower: 0,
      rate: 0,
      hour: null
    };
  }

  const hourlyUsage = new Map();

  for (const portion of portions) {
    if (!portion || !(portion.hours > 1e-6) || !(portion.start instanceof Date)) {
      continue;
    }

    let remaining = portion.hours;
    let cursor = new Date(portion.start.getTime());

    while (remaining > 1e-6) {
      const hourStart = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cursor.getDate(),
        cursor.getHours(),
        0,
        0,
        0
      );
      const nextHourStart = new Date(hourStart.getTime() + HOUR_IN_MS);

      let sliceHours = (nextHourStart.getTime() - cursor.getTime()) / HOUR_IN_MS;

      if (!Number.isFinite(sliceHours) || sliceHours <= 1e-6) {
        sliceHours = Math.min(remaining, 1);
      } else {
        sliceHours = Math.min(sliceHours, remaining);
      }

      const usage = resolveTehoUsage(cursor);
      const hourKey = `${formatDateKey(hourStart)}T${String(hourStart.getHours()).padStart(2, '0')}:00:00`;

      let data = hourlyUsage.get(hourKey);

      if (!data) {
        data = {
          energy: 0,
          apply: false,
          rate: 0,
          hourStart: new Date(hourStart.getTime())
        };
        hourlyUsage.set(hourKey, data);
      }

      data.energy += chargingPower * sliceHours;

      if (usage.apply) {
        data.apply = true;

        if (Number.isFinite(usage.rate) && usage.rate >= 0) {
          data.rate = usage.rate;
        }
      }

      cursor = new Date(cursor.getTime() + sliceHours * HOUR_IN_MS);
      remaining -= sliceHours;
    }
  }

  let maxAveragePower = 0;
  let appliedRate = 0;
  let appliedHour = null;

  for (const data of hourlyUsage.values()) {
    if (!data.apply) {
      continue;
    }

    const averagePower = data.energy;

    if (
      averagePower > maxAveragePower + 1e-6 ||
      (Math.abs(averagePower - maxAveragePower) <= 1e-6 && data.rate > appliedRate)
    ) {
      maxAveragePower = averagePower;
      appliedRate = Number.isFinite(data.rate) ? data.rate : 0;
      appliedHour = data.hourStart ? new Date(data.hourStart.getTime()) : null;
    }
  }

  return {
    cost: maxAveragePower * appliedRate,
    maxAveragePower,
    rate: appliedRate,
    hour: appliedHour
  };
}

function formatDuration(hours) {
  const totalMinutes = Math.round(hours * 60);
  const hPart = Math.floor(totalMinutes / 60);
  const mPart = totalMinutes % 60;

  if (mPart === 0) {
    return `${hPart} h`;
  }

  if (hPart === 0) {
    return `${mPart} min`;
  }

  return `${hPart} h ${mPart} min`;
}

function calculateOptimalPlan(
  prices,
  chargingPower,
  energyAmount,
  costConfig,
  includeTeho,
  electricityMargin
) {
  if (!Array.isArray(prices) || prices.length === 0) {
    return null;
  }

  if (!(chargingPower > 0) || !(energyAmount > 0)) {
    return null;
  }

  const safeConfig = costConfig || defaultCostConfiguration;
  const margin = Number.isFinite(electricityMargin) ? Math.max(electricityMargin, 0) : 0;

  const getRateForMoment = (branch, date) => {
    if (!branch || !(date instanceof Date) || Number.isNaN(date.getTime())) {
      return 0;
    }

    const minutes = date.getHours() * 60 + date.getMinutes();
    const dayIndex = date.getDay();
    const dateKey = formatDateKey(date);

    for (const tier of branch.tiers || []) {
      const rate = Number(tier?.rate);

      if (!Number.isFinite(rate) || !Array.isArray(tier?.intervals)) {
        continue;
      }

      if (typeof tier.startDate === 'string' && dateKey < tier.startDate) {
        continue;
      }

      if (typeof tier.endDate === 'string' && dateKey > tier.endDate) {
        continue;
      }

      const tierWeekdays = Array.isArray(tier.weekdays) ? tier.weekdays : [];

      if (tierWeekdays.length && !tierWeekdays.includes(dayIndex)) {
        continue;
      }

      for (const interval of tier.intervals) {
        if (
          !interval ||
          typeof interval.startMinutes !== 'number' ||
          typeof interval.endMinutes !== 'number'
        ) {
          continue;
        }

        const intervalDays = Array.isArray(interval.days) && interval.days.length
          ? interval.days
          : tierWeekdays;

        if (intervalDays.length && !intervalDays.includes(dayIndex)) {
          continue;
        }

        if (minutes >= interval.startMinutes && minutes < interval.endMinutes) {
          return rate;
        }
      }
    }

    return 0;
  };

  const sorted = prices
    .map((entry) => ({
      start: new Date(entry.startTime),
      spotPrice: Number(entry.price)
    }))
    .filter((entry) => Number.isFinite(entry.start.getTime()) && Number.isFinite(entry.spotPrice))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (sorted.length === 0) {
    return null;
  }

  const intervalDiffs = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const diffHours = (next.start.getTime() - current.start.getTime()) / (60 * 60 * 1000);

    if (Number.isFinite(diffHours) && diffHours > 1e-6) {
      intervalDiffs.push(diffHours);
    }
  }

  const sortedDiffs = intervalDiffs.sort((a, b) => a - b);
  const medianIndex = Math.floor(sortedDiffs.length / 2);
  const fallbackDuration =
    sortedDiffs.length > 0
      ? sortedDiffs.length % 2 === 0
        ? (sortedDiffs[medianIndex - 1] + sortedDiffs[medianIndex]) / 2
        : sortedDiffs[medianIndex]
      : 1;

  const now = new Date();
  const nowTime = now.getTime();

  const normalized = sorted
    .map((entry, index) => {
      const next = sorted[index + 1];
      let durationHours = next
        ? (next.start.getTime() - entry.start.getTime()) / (60 * 60 * 1000)
        : fallbackDuration;

      if (!Number.isFinite(durationHours) || durationHours <= 1e-6) {
        durationHours = fallbackDuration;
      }

      const clampedDuration = Math.max(Math.min(durationHours, 6), 0.15);
      const rawEndTime = entry.start.getTime() + clampedDuration * HOUR_IN_MS;

      if (!Number.isFinite(rawEndTime)) {
        return null;
      }

      if (rawEndTime <= nowTime + 1) {
        return null;
      }

      let effectiveStartTime = entry.start.getTime();
      let effectiveDuration = clampedDuration;

      if (effectiveStartTime < nowTime) {
        const remainingHours = (rawEndTime - nowTime) / HOUR_IN_MS;

        if (!(remainingHours > 1e-6)) {
          return null;
        }

        effectiveStartTime = nowTime;
        effectiveDuration = remainingHours;
      }

      const effectiveStart = new Date(effectiveStartTime);

      return {
        start: effectiveStart,
        spotPrice: entry.spotPrice,
        durationHours: effectiveDuration,
        end: new Date(effectiveStartTime + effectiveDuration * HOUR_IN_MS)
      };
    })
    .filter((entry) => entry && entry.durationHours > 1e-6);

  let bestPlan = null;

  const tehoConfig = safeConfig.teho || {};
  const hasTehoPricing = Array.isArray(tehoConfig.tiers) && tehoConfig.tiers.length > 0;
  const shouldApplyTeho = includeTeho && hasTehoPricing;

  const resolveTehoUsage = (date) => {
    if (!shouldApplyTeho) {
      return { apply: false, rate: 0 };
    }

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return { apply: false, rate: 0 };
    }

    const rate = getRateForMoment(tehoConfig, date);

    if (!(rate > 0)) {
      return { apply: false, rate: 0 };
    }

    return {
      apply: true,
      rate
    };
  };

  for (let i = 0; i < normalized.length; i += 1) {
    let energyRemaining = energyAmount;
    let j = i;
    let energyCost = 0;
    let siirtoCost = 0;
    let duration = 0;
    const portionMap = {};
    const tehoPortions = [];

    while (energyRemaining > 1e-6 && j < normalized.length) {
      const entry = normalized[j];
      const availableHours = entry.durationHours;

      if (!(availableHours > 0)) {
        j += 1;
        continue;
      }

      const possibleHours = energyRemaining / chargingPower;
      const portionHours = Math.min(availableHours, possibleHours);

      if (!(portionHours > 0)) {
        break;
      }

      const energyThisPortion = chargingPower * portionHours;
      const siirtoRate = getRateForMoment(safeConfig.siirto, entry.start);
      const tehoUsage = resolveTehoUsage(entry.start);
      const tehoApplies = shouldApplyTeho && tehoUsage.apply;
      const tehoRate = shouldApplyTeho ? tehoUsage.rate : 0;

      const energyRate = entry.spotPrice + margin;

      energyCost += energyThisPortion * energyRate;
      siirtoCost += energyThisPortion * siirtoRate;
      portionMap[j] = {
        hours: portionHours,
        siirtoRate,
        spotPrice: entry.spotPrice,
        energyRate
      };
      if (shouldApplyTeho) {
        portionMap[j].tehoRate = tehoRate;
        portionMap[j].tehoApplies = tehoApplies;
      }
      if (shouldApplyTeho) {
        tehoPortions.push({ start: entry.start, hours: portionHours });
      }
      duration += portionHours;
      energyRemaining -= energyThisPortion;

      if (energyRemaining <= 1e-6) {
        energyRemaining = 0;
        break;
      }

      j += 1;
    }

    if (energyRemaining > 1e-6) {
      continue;
    }

    const chargedIndices = Object.keys(portionMap).map(Number);

    if (!chargedIndices.length) {
      continue;
    }

    const startIndex = Math.min(...chargedIndices);
    const endIndex = Math.max(...chargedIndices);
    const endEntry = normalized[endIndex];
    const endPortion = portionMap[endIndex];
    const endTime = new Date(
      endEntry.start.getTime() + (endPortion?.hours ?? 0) * 60 * 60 * 1000
    );

    const tehoMetrics = shouldApplyTeho
      ? calculateTehoMetrics(tehoPortions, chargingPower, resolveTehoUsage)
      : { cost: 0, maxAveragePower: 0, rate: 0, hour: null };

    const sahkoveroCost = energyAmount * SAHKOVERO_RATE_PER_KWH;
    const totalCost = energyCost + siirtoCost + tehoMetrics.cost + sahkoveroCost;

    if (!bestPlan || totalCost < bestPlan.totalCost) {
      const timeline = normalized
        .map((entry, index) => {
          const portion = portionMap[index];
          const chargedHours = portion?.hours ?? 0;
          const energyRate = portion?.energyRate ?? entry.spotPrice + margin;

          return {
            startTime: entry.start,
            endTime: new Date(entry.start.getTime() + chargedHours * 60 * 60 * 1000),
            price: energyRate,
            spotPrice: entry.spotPrice,
            margin,
            chargedHours,
            siirtoRate: portion?.siirtoRate ?? 0,
            tehoRate: shouldApplyTeho ? portion?.tehoRate ?? 0 : null,
            tehoApplies: shouldApplyTeho ? Boolean(portion?.tehoApplies) : false,
            isWithin: Boolean(portion)
          };
        })
        .filter((entry) => entry.isWithin && entry.chargedHours > 1e-6);

      bestPlan = {
        startIndex,
        endIndex,
        startTime: normalized[startIndex].start,
        endTime,
        durationHours: duration,
        energyCost,
        siirtoCost,
        sahkoveroCost,
        tehoCost: shouldApplyTeho ? tehoMetrics.cost : 0,
        electricityMargin: margin,
        totalCost,
        averageEnergyPrice: energyCost / energyAmount,
        averageTotalPrice: totalCost / energyAmount,
        timeline,
        maxHourlyAveragePower: shouldApplyTeho ? tehoMetrics.maxAveragePower : null,
        tehoRate: shouldApplyTeho ? tehoMetrics.rate : null,
        tehoHour: shouldApplyTeho ? tehoMetrics.hour : null,
        tehoEnabled: shouldApplyTeho
      };
    }
  }

  return bestPlan;
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  displayFormatter
}) {
  const displayValue = displayFormatter ? displayFormatter(value) : value.toFixed(1);

  return h(
    'div',
    { className: 'slider-control' },
    h(
      'label',
      null,
      h('span', null, label),
      h('span', { className: 'value' }, `${displayValue} ${unit}`)
    ),
    h('input', {
      type: 'range',
      min,
      max,
      step,
      value,
      onChange: (event) => onChange(Number(event.target.value))
    })
  );
}

function PricingSelector({ options, value, onChange, disabled }) {
  const selectId = 'pricing-select';
  const hasOptions = Array.isArray(options) && options.length > 0;

  return h(
    'div',
    { className: 'select-control' },
    h('label', { htmlFor: selectId }, 'Hinnoittelu'),
    h(
      'select',
      {
        id: selectId,
        className: 'select-control__field',
        value: value || '',
        onChange: (event) => onChange(event.target.value),
        disabled: disabled || !hasOptions
      },
      hasOptions
        ? options.map((option) =>
            h('option', { key: option.id, value: option.id }, option.name)
          )
        : [h('option', { key: 'empty', value: '' }, 'Hinnoittelua ei ole saatavilla')]
    )
  );
}

function TehoModeTabs({ value, onChange }) {
  return h(
    'div',
    { className: 'tab-group' },
    h(
      'button',
      {
        type: 'button',
        className: `tab${value === 'include' ? ' is-active' : ''}`,
        onClick: () => onChange('include')
      },
      'Huomioi tehomaksu'
    ),
    h(
      'button',
      {
        type: 'button',
        className: `tab${value === 'ignore' ? ' is-active' : ''}`,
        onClick: () => onChange('ignore')
      },
      'Ohita tehomaksu'
    )
  );
}

function FullChargeToggle({ checked, onChange }) {
  return h(
    'label',
    { className: 'checkbox-control' },
    h('input', {
      type: 'checkbox',
      checked,
      onChange: (event) => onChange(event.target.checked)
    }),
    h('span', null, 'Täysi akku (hidastaa latausta noin 15 % loppua kohden)')
  );
}

function SummaryPanel({ plan, chargingTimeHours, loading, error, tehoMode, pricingName }) {
  const pricingLabel = pricingName
    ? h('p', { className: 'summary-subtitle' }, `Hinnoittelu: ${pricingName}`)
    : null;

  if (loading) {
    return h(
      'div',
      { className: 'summary-card' },
      pricingLabel,
      h('div', { className: 'loading-spinner' })
    );
  }

  if (error) {
    return h(
      'div',
      { className: 'summary-card' },
      pricingLabel,
      h('p', { className: 'error' }, error)
    );
  }

  if (!plan) {
    return h(
      'div',
      { className: 'summary-card' },
      pricingLabel,
      h(
        'p',
        { className: 'placeholder' },
        'Säädä latausasetuksia tai odota hintadatan päivittymistä.'
      )
    );
  }

  const showTeho = tehoMode === 'include' && plan.tehoEnabled;

  return h(
    'div',
    { className: 'summary-card' },
    h('h2', null, 'Optimaalinen latausikkuna'),
    pricingLabel,
    h('p', { className: 'placeholder' }, `Latausaika noin ${formatDuration(chargingTimeHours)}`),
    h(
      'div',
      { className: 'metrics' },
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Aloitus'),
        h('span', { className: 'value' }, dateFormatter.format(plan.startTime))
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Valmis'),
        h('span', { className: 'value' }, dateFormatter.format(plan.endTime))
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Sähköenergia'),
        h('span', { className: 'value' }, currencyFormatter.format(plan.energyCost))
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Välityspalkkio (snt/kWh)'),
        h(
          'span',
          { className: 'value' },
          `${marginFormatter.format((plan.electricityMargin ?? 0) * 100)} snt/kWh`
        )
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Siirtomaksu'),
        h('span', { className: 'value' }, currencyFormatter.format(plan.siirtoCost))
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Sähkövero'),
        h('span', { className: 'value' }, currencyFormatter.format(plan.sahkoveroCost))
      ),
      showTeho
        ? h(
            'div',
            { className: 'metric' },
            h('span', { className: 'label' }, 'Tehomaksu (arvio)'),
            h('span', { className: 'value' }, currencyFormatter.format(plan.tehoCost))
          )
        : null,
      showTeho
        ? h(
            'div',
            { className: 'metric' },
            h('span', { className: 'label' }, 'Tehomaksu €/kW'),
            h(
              'span',
              { className: 'value' },
              `${priceFormatter.format(plan.tehoRate ?? 0)} €/kW`
            )
          )
        : null,
      showTeho
        ? h(
            'div',
            { className: 'metric' },
            h('span', { className: 'label' }, 'Maksimituntiteho'),
            h(
              'span',
              { className: 'value' },
              `${powerFormatter.format(plan.maxHourlyAveragePower ?? 0)} kW`
            )
          )
        : null,
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Kokonaiskustannus'),
        h('span', { className: 'value' }, currencyFormatter.format(plan.totalCost))
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Keskihinta energia'),
        h('span', { className: 'value' }, `${priceFormatter.format(plan.averageEnergyPrice)} €/kWh`)
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'label' }, 'Keskihinta kokonaisena'),
        h('span', { className: 'value' }, `${priceFormatter.format(plan.averageTotalPrice)} €/kWh`)
      )
    )
  );
}

function Timeline({ plan, tehoMode }) {
  const timelineEntries = plan?.timeline ?? [];

  if (!timelineEntries.length) {
    return h(
      'div',
      { className: 'summary-card' },
      h('p', { className: 'placeholder' }, 'Latausikkunaa ei löytynyt valituilla arvoilla.')
    );
  }

  const showTeho = tehoMode === 'include' && Boolean(plan?.tehoEnabled);

  return h(
    'div',
    { className: 'timeline-grid' },
    timelineEntries.map((entry, index) => {
      const startDate = new Date(entry.startTime);
      const endDate = entry.endTime ? new Date(entry.endTime) : null;
      const tehoDisplay = `${priceFormatter.format(entry.tehoRate ?? 0)} €/kW`;
      const tehoValueClass = `detail-value${entry.tehoApplies ? '' : ' is-muted'}`;

      return h(
        'div',
        {
          key: entry.startTime || index,
          className: 'timeline-card is-optimal'
        },
        h(
          'span',
          { className: 'hour' },
          endDate ? `${timeFormatter.format(startDate)} – ${timeFormatter.format(endDate)}` : timeFormatter.format(startDate)
        ),
        h(
          'div',
          { className: 'detail-row' },
          h('span', { className: 'detail-label' }, 'Spot-hinta'),
          h('span', { className: 'detail-value' }, `${priceFormatter.format(entry.spotPrice ?? 0)} €/kWh`)
        ),
        h(
          'div',
          { className: 'detail-row' },
          h('span', { className: 'detail-label' }, 'Välitysmaksu'),
          h(
            'span',
            { className: 'detail-value' },
            `${marginFormatter.format((entry.margin ?? 0) * 100)} snt/kWh`
          )
        ),
        h(
          'div',
          { className: 'detail-row' },
          h('span', { className: 'detail-label' }, 'Sähköenergia (sis. marginaalin)'),
          h('span', { className: 'detail-value' }, `${priceFormatter.format(entry.price)} €/kWh`)
        ),
        h(
          'div',
          { className: 'detail-row' },
          h('span', { className: 'detail-label' }, 'Siirto'),
          h('span', { className: 'detail-value' }, `${priceFormatter.format(entry.siirtoRate ?? 0)} €/kWh`)
        ),
        showTeho
          ? h(
              'div',
              { className: 'detail-row' },
              h('span', { className: 'detail-label' }, 'Teho'),
              h('span', { className: tehoValueClass }, tehoDisplay)
            )
          : null
      );
    })
  );
}

function App() {
  const [chargingPower, setChargingPower] = useState(DEFAULT_CHARGING_POWER);
  const [energyAmount, setEnergyAmount] = useState(DEFAULT_ENERGY_AMOUNT);
  const [electricityMargin, setElectricityMargin] = useState(DEFAULT_ELECTRICITY_MARGIN);
  const [prices, setPrices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [costConfig, setCostConfig] = useState(defaultCostConfiguration);
  const [tehoMode, setTehoMode] = useState(DEFAULT_TEHO_MODE);
  const [fullCharge, setFullCharge] = useState(DEFAULT_FULL_CHARGE);
  const [pricingOptions, setPricingOptions] = useState([]);
  const [selectedPricingId, setSelectedPricingId] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [dialog, setDialog] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const savedSettingsRef = React.useRef(null);
  const dialogCloseRef = React.useRef(null);

  useEffect(() => {
    const saved = loadStoredSettings();

    if (!saved) {
      savedSettingsRef.current = null;
      return;
    }

    savedSettingsRef.current = saved;

    if (saved.chargingPower !== undefined) {
      setChargingPower(normalizeChargingPower(saved.chargingPower));
    }

    if (saved.energyAmount !== undefined) {
      setEnergyAmount(normalizeEnergyAmount(saved.energyAmount));
    }

    if (typeof saved.fullCharge === 'boolean') {
      setFullCharge(saved.fullCharge);
    }

    if (isValidTehoMode(saved.tehoMode)) {
      setTehoMode(saved.tehoMode);
    }

    if (saved.electricityMargin !== undefined) {
      setElectricityMargin(normalizeElectricityMargin(saved.electricityMargin));
    }
  }, []);

  useEffect(() => {
    if (!actionMessage) {
      return;
    }

    const timer = setTimeout(() => setActionMessage(''), 2400);

    return () => {
      clearTimeout(timer);
    };
  }, [actionMessage]);

  useEffect(() => {
    if (!dialog || typeof window === 'undefined') {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setDialog(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [dialog]);

  useEffect(() => {
    if (dialog && dialogCloseRef.current) {
      dialogCloseRef.current.focus();
    }
  }, [dialog]);

  useEffect(() => {
    let active = true;

    async function loadManifest() {
      setLoading(true);

      try {
        const manifest = await fetchPricingManifest();

        if (!active) {
          return;
        }

        const options = manifest.pricings || [];
        setPricingOptions(options);

        const knownIds = new Set(options.map((option) => option.id));
        const fallbackCandidate =
          (manifest.defaultId && knownIds.has(manifest.defaultId) && manifest.defaultId) ||
          options[0]?.id ||
          '';

        const savedCandidate =
          typeof savedSettingsRef.current?.pricingId === 'string'
            ? savedSettingsRef.current.pricingId
            : '';

        const initialId =
          (savedCandidate && knownIds.has(savedCandidate) && savedCandidate) || fallbackCandidate;

        setSelectedPricingId(initialId);
        setError('');

        if (!initialId) {
          setLoading(false);
        }
      } catch (err) {
        if (!active) {
          return;
        }

        console.error('Pricing manifest load failed:', err);
        setPricingOptions([]);
        setError('Hinnoitteluvaihtoehtojen haku epäonnistui. Tarkista yhteys ja yritä uudelleen.');
        setLoading(false);
      }
    }

    loadManifest();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !selectedPricingId) {
      return;
    }

    const interval = window.setInterval(() => {
      setReloadToken((token) => token + 1);
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [selectedPricingId]);

  useEffect(() => {
    if (!selectedPricingId) {
      return;
    }

    const pricingEntry = pricingOptions.find((option) => option.id === selectedPricingId);

    if (!pricingEntry) {
      setError('Valittua hinnoittelua ei löydy.');
      setCostConfig(defaultCostConfiguration);
      setLoading(false);
      return;
    }

    let mounted = true;
    setLoading(true);
    setError('');

    async function loadData() {
      try {
        const [priceData, configData] = await Promise.all([
          fetchSpotPrices(),
          fetchCostConfiguration(pricingEntry)
        ]);

        if (!mounted) {
          return;
        }

        setPrices(priceData);
        setCostConfig(configData);

        if (!priceData.length) {
          setError('Hintadataa ei ole saatavilla juuri nyt. Yritä myöhemmin uudelleen.');
        } else {
          setError('');
        }
      } catch (err) {
        if (!mounted) {
          return;
        }

        console.error('Pricing load failed:', err);
        const message = String(err?.message || '').toLowerCase();

        if (message.includes('hinnaston')) {
          setError('Hinnoittelun lataus epäonnistui. Tarkista yhteys ja yritä uudelleen.');
        } else {
          setError('Hintadatan haku epäonnistui. Tarkista yhteys ja yritä uudelleen.');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      mounted = false;
    };
  }, [selectedPricingId, pricingOptions, reloadToken]);

  const effectiveChargingPower = useMemo(
    () => (fullCharge ? chargingPower * FULL_CHARGE_FACTOR : chargingPower),
    [chargingPower, fullCharge]
  );

  const plan = useMemo(
    () =>
      calculateOptimalPlan(
        prices,
        effectiveChargingPower,
        energyAmount,
        costConfig,
        tehoMode === 'include',
        electricityMargin
      ),
    [prices, effectiveChargingPower, energyAmount, costConfig, tehoMode, electricityMargin]
  );

  const chargingTimeHours = useMemo(
    () => (effectiveChargingPower > 0 ? energyAmount / effectiveChargingPower : 0),
    [energyAmount, effectiveChargingPower]
  );

  const selectedPricing = useMemo(
    () => pricingOptions.find((option) => option.id === selectedPricingId) || null,
    [pricingOptions, selectedPricingId]
  );

  const pricingName = selectedPricing?.name || '';
  const hasPricing = Boolean(selectedPricingId);

  useEffect(() => {
    if (!selectedPricingId) {
      return;
    }

    if (savedSettingsRef.current?.pricingId === selectedPricingId) {
      return;
    }

    const nextSettings = {
      ...(savedSettingsRef.current && typeof savedSettingsRef.current === 'object'
        ? savedSettingsRef.current
        : {}),
      pricingId: selectedPricingId
    };

    savedSettingsRef.current = nextSettings;
    persistSettings(nextSettings);
  }, [selectedPricingId]);

  const handlePricingChange = (nextValue) => {
    if (!nextValue || nextValue === selectedPricingId) {
      return;
    }

    setSelectedPricingId(nextValue);
  };

  const handleSaveSettings = () => {
    if (!hasPricing) {
      setActionMessage('Valitse hinnoittelu ennen tallennusta.');
      setDialog(null);
      return;
    }

    const success = persistSettings({
      chargingPower,
      energyAmount,
      fullCharge,
      tehoMode,
      electricityMargin,
      pricingId: selectedPricingId
    });

    if (success) {
      savedSettingsRef.current = {
        chargingPower,
        energyAmount,
        fullCharge,
        tehoMode,
        electricityMargin,
        pricingId: selectedPricingId
      };
      setActionMessage('Asetukset tallennettu selaimen muistiin.');
      setDialog({
        title: 'Asetukset tallennettu',
        message: 'Valitut latausasetukset ovat nyt tallessa tässä selaimessa.'
      });
    } else {
      setActionMessage('Asetusten tallennus epäonnistui. Tarkista selaimen tallennustila.');
      setDialog(null);
    }
  };

  const handleShare = async () => {
    if (!hasPricing || typeof window === 'undefined') {
      return;
    }

    const shareUrl = window.location.href;

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = shareUrl;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      setActionMessage('Linkki kopioitu leikepöydälle.');
    } catch (err) {
      console.warn('Share failed:', err);
      setActionMessage('Linkin kopiointi epäonnistui. Kopioi osoite käsin.');
    }
  };

  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'page-container' },
      h(
        'div',
        { className: 'app-shell' },
        h(
          'header',
          { className: 'app-header' },
          h(
            'div',
            { className: 'header-top' },
            h('h1', null, 'Optimaalisin latausikkuna SPOT-hinnoittelulla'),
            h(
              'button',
              {
                type: 'button',
                className: 'toolbar-button is-secondary share-button',
                onClick: handleShare,
                disabled: !hasPricing
              },
              'Kopio linkki'
            )
          ),
          h(
            'p',
            null,
            'Optimoi sähköautosi latauskulut pörssisähkön ja siirto- ja tehomaksun hintavaihteluja hyödyntäen. Valitse latausteho, energian tarve ja välityspalkkio nähdäksesi, milloin on edullisinta ladata.'
          )
        ),
        h(
          'main',
          { className: 'app-content' },
          h(
            'section',
            { className: 'control-panel' },
            h(
              'div',
              { className: 'control-meta' },
              h(PricingSelector, {
                options: pricingOptions,
                value: selectedPricingId,
                onChange: handlePricingChange,
                disabled: !pricingOptions.length
              }),
              actionMessage
                ? h('p', { className: 'action-message' }, actionMessage)
                : null
            ),
            h(
              'div',
              { className: 'slider-group' },
              h(SliderControl, {
                label: 'Ladattava energia',
                value: energyAmount,
                min: ENERGY_AMOUNT_RANGE.min,
                max: ENERGY_AMOUNT_RANGE.max,
                step: 1,
                unit: 'kWh',
                onChange: setEnergyAmount,
                displayFormatter: (val) => val.toFixed(0)
              }),
              h(SliderControl, {
                label: 'Latausteho',
                value: chargingPower,
                min: CHARGING_POWER_RANGE.min,
                max: CHARGING_POWER_RANGE.max,
                step: 0.5,
                unit: 'kW',
                onChange: setChargingPower,
                displayFormatter: (val) => val.toFixed(1)
              }),
              h(SliderControl, {
                label: 'Sähkön välitysmaksu',
                value: electricityMargin * 100,
                min: ELECTRICITY_MARGIN_RANGE.min * 100,
                max: ELECTRICITY_MARGIN_RANGE.max * 100,
                step: 0.01,
                unit: 'snt/kWh',
                onChange: (val) =>
                  setElectricityMargin(normalizeElectricityMargin(val / 100)),
                displayFormatter: (val) => marginFormatter.format(val)
              })
            ),
            h(
              'div',
              { className: 'control-options' },
              h(FullChargeToggle, { checked: fullCharge, onChange: setFullCharge }),
              h(TehoModeTabs, { value: tehoMode, onChange: setTehoMode })
            )
          ),
          h(
            'section',
            { className: 'summary-panel' },
            h(SummaryPanel, {
              plan,
              chargingTimeHours,
              loading,
              error,
              tehoMode,
              pricingName
            })
          ),
          h(
            'section',
            { className: 'timeline-panel' },
            h('h2', null, 'Latausikkunan tuntihinnat'),
            h(Timeline, { plan, tehoMode })
          ),
          h(
            'div',
            { className: 'save-footer' },
            h(
              'button',
              {
                type: 'button',
                className: 'toolbar-button is-primary',
                onClick: handleSaveSettings,
                disabled: !hasPricing
              },
              'Tallenna asetukset'
            )
          )
        )
      ),
      h(
        'div',
        { className: 'save-footer' },
        h(
          'nav',
          { className: 'site-footer__links', 'aria-label': 'Lisätietolinkit' },
          h(
            'a',
            {
              href: 'about.html',
              className: 'site-footer__link'
            },
            'Tietoa sovelluksesta'
          ),
          h(
            'a',
            {
              href: 'privacy.html',
              className: 'site-footer__link'
            },
            'Tietosuojaseloste'
          ),
          h(
            'a',
            {
              href: 'mailto:info@lataafiksusti.fi',
              className: 'site-footer__link'
            },
            'Ota yhteyttä'
          )
        )
      )
    ),
    dialog
      ? h(
          'div',
          {
            className: 'dialog-backdrop',
            role: 'presentation',
            onClick: () => setDialog(null)
          },
          h(
            'div',
            {
              className: 'dialog-panel',
              role: 'alertdialog',
              'aria-modal': 'true',
              'aria-labelledby': 'save-dialog-title',
              'aria-describedby': 'save-dialog-description',
              onClick: (event) => event.stopPropagation()
            },
            h('h3', { id: 'save-dialog-title' }, dialog.title),
            h('p', { id: 'save-dialog-description' }, dialog.message),
            h(
              'div',
              { className: 'dialog-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dialog-button',
                  onClick: () => setDialog(null),
                  ref: dialogCloseRef
                },
                'OK'
              )
            )
          )
        )
      : null
  );
}

const container = document.getElementById('root');
const root = createRoot(container);
root.render(h(App));
