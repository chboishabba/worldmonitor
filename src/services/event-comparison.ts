import type { NewsItem } from '@/types';
import { jaccardSimilarity, tokenize } from '@/utils/analysis-constants';

export type EventComparisonConfidence = 'low' | 'medium' | 'high';

export interface EventComparisonSignals {
  text: number;
  time: number;
  geo: number | null;
}

export interface EventComparison {
  similarity: number;
  confidence: EventComparisonConfidence;
  sharedFeatures: string[];
  differingFeatures: string[];
  signals: EventComparisonSignals;
}

export interface ClusterCoherenceSummary {
  coherence: number;
  confidence: EventComparisonConfidence;
  comparisonCount: number;
  weakestPair: EventComparison | null;
}

export interface EventComparisonEnvelope {
  envelopeType: 'wm.event_comparison.v1';
  leftEvent: {
    id: string;
    title: string;
    timestamp: string;
    geo: { lat: number; lon: number } | null;
    source: string;
  };
  rightEvent: {
    id: string;
    title: string;
    timestamp: string;
    geo: { lat: number; lon: number } | null;
    source: string;
  };
  comparison: EventComparison;
  meta: {
    generatedBy: 'wm.event_comparison';
    version: 'v1';
  };
}

const GEO_DISTANCE_WINDOW_KM = 100;
const TIME_DISTANCE_WINDOW_MS = 6 * 60 * 60 * 1000;
const SHARED_TOKEN_LIMIT = 5;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeTitle(item: NewsItem): string {
  return [item.title, item.locationName].filter(Boolean).join(' ').trim();
}

function buildStableEventId(item: NewsItem): string {
  const raw = `${item.source}|${item.link}|${item.pubDate.toISOString()}`;
  let hash = 0;
  for (let index = 0; index < raw.length; index++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(index);
    hash |= 0;
  }
  return `evt-${Math.abs(hash).toString(16)}`;
}

function toGeo(item: NewsItem): { lat: number; lon: number } | null {
  return item.lat == null || item.lon == null ? null : { lat: item.lat, lon: item.lon };
}

function toConfidence(similarity: number): EventComparisonConfidence {
  if (similarity >= 0.75) return 'high';
  if (similarity >= 0.45) return 'medium';
  return 'low';
}

function haversineKm(left: { lat: number; lon: number }, right: { lat: number; lon: number }): number {
  const radiusKm = 6371;
  const dLat = toRadians(right.lat - left.lat);
  const dLon = toRadians(right.lon - left.lon);
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return radiusKm * c;
}

function toRadians(value: number): number {
  return value * (Math.PI / 180);
}

export function compareNewsItems(left: NewsItem, right: NewsItem): EventComparison {
  const leftTokens = tokenize(normalizeTitle(left));
  const rightTokens = tokenize(normalizeTitle(right));
  const text = jaccardSimilarity(leftTokens, rightTokens);

  const timeDiffMs = Math.abs(left.pubDate.getTime() - right.pubDate.getTime());
  const time = clamp(1 - (timeDiffMs / TIME_DISTANCE_WINDOW_MS));

  const leftGeo = toGeo(left);
  const rightGeo = toGeo(right);
  const geoDistanceKm = leftGeo && rightGeo ? haversineKm(leftGeo, rightGeo) : null;
  const geo = geoDistanceKm == null ? null : clamp(1 - (geoDistanceKm / GEO_DISTANCE_WINDOW_KM));

  const scoreParts = geo == null ? [text, time] : [text, time, geo];
  const similarity = roundMetric(scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length);

  const sharedTokens = [...leftTokens].filter(token => rightTokens.has(token)).slice(0, SHARED_TOKEN_LIMIT);
  const sharedFeatures: string[] = [];
  if (sharedTokens.length > 0) {
    sharedFeatures.push(`shared terms: ${sharedTokens.join(', ')}`);
  }
  if (left.locationName && right.locationName && left.locationName.toLowerCase() === right.locationName.toLowerCase()) {
    sharedFeatures.push(`shared location label: ${left.locationName}`);
  }
  if (timeDiffMs <= 2 * 60 * 60 * 1000) {
    sharedFeatures.push(`time window: ${Math.round(timeDiffMs / 60000)} minutes apart`);
  }
  if (geoDistanceKm != null && geoDistanceKm <= 50) {
    sharedFeatures.push(`geo proximity: ${Math.round(geoDistanceKm)} km`);
  }

  const differingFeatures: string[] = [];
  if (left.source !== right.source) {
    differingFeatures.push(`sources differ: ${left.source} vs ${right.source}`);
  }
  if (timeDiffMs > 2 * 60 * 60 * 1000) {
    differingFeatures.push(`time offset: ${Math.round(timeDiffMs / 3600000)}h`);
  }
  if (geoDistanceKm != null && geoDistanceKm > 50) {
    differingFeatures.push(`geo offset: ${Math.round(geoDistanceKm)} km`);
  }
  if (sharedTokens.length === 0) {
    differingFeatures.push('no shared title terms');
  }

  return {
    similarity,
    confidence: toConfidence(similarity),
    sharedFeatures,
    differingFeatures,
    signals: {
      text: roundMetric(text),
      time: roundMetric(time),
      geo: geo == null ? null : roundMetric(geo),
    },
  };
}

export function scoreClusterCoherence(items: NewsItem[]): ClusterCoherenceSummary {
  if (items.length < 2) {
    return {
      coherence: 1,
      confidence: 'high',
      comparisonCount: 0,
      weakestPair: null,
    };
  }

  const comparisons: EventComparison[] = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex++) {
    const left = items[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex++) {
      const right = items[rightIndex];
      if (!right) continue;
      comparisons.push(compareNewsItems(left, right));
    }
  }

  const coherence = roundMetric(
    comparisons.reduce((sum, comparison) => sum + comparison.similarity, 0) / comparisons.length
  );
  const weakestPair = [...comparisons].sort((left, right) => left.similarity - right.similarity)[0] ?? null;
  return {
    coherence,
    confidence: toConfidence(coherence),
    comparisonCount: comparisons.length,
    weakestPair,
  };
}

export function buildEventComparisonEnvelope(
  left: NewsItem,
  right: NewsItem,
  comparison = compareNewsItems(left, right),
): EventComparisonEnvelope {
  return {
    envelopeType: 'wm.event_comparison.v1',
    leftEvent: {
      id: buildStableEventId(left),
      title: left.title,
      timestamp: left.pubDate.toISOString(),
      geo: toGeo(left),
      source: left.source,
    },
    rightEvent: {
      id: buildStableEventId(right),
      title: right.title,
      timestamp: right.pubDate.toISOString(),
      geo: toGeo(right),
      source: right.source,
    },
    comparison,
    meta: {
      generatedBy: 'wm.event_comparison',
      version: 'v1',
    },
  };
}
