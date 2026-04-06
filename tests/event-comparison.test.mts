import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NewsItem } from '../src/types/index.ts';
import {
  buildEventComparisonEnvelope,
  compareNewsItems,
  scoreClusterCoherence,
} from '../src/services/event-comparison.ts';

function makeNewsItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    source: 'Reuters',
    title: 'Explosion reported near Odesa port after overnight drone attack',
    link: 'https://example.test/reuters/odesa',
    pubDate: new Date('2026-04-06T00:00:00Z'),
    isAlert: true,
    lat: 46.4825,
    lon: 30.7233,
    locationName: 'Odesa',
    ...overrides,
  };
}

describe('compareNewsItems', () => {
  it('scores nearby, similarly worded reports as high confidence', () => {
    const left = makeNewsItem();
    const right = makeNewsItem({
      source: 'AP',
      title: 'Drone attack causes explosion near Odesa port overnight',
      link: 'https://example.test/ap/odesa',
      pubDate: new Date('2026-04-06T00:45:00Z'),
      lat: 46.48,
      lon: 30.73,
    });

    const result = compareNewsItems(left, right);

    assert.equal(result.confidence, 'high');
    assert.ok(result.similarity >= 0.75, `expected high similarity, got ${result.similarity}`);
    assert.ok(result.sharedFeatures.some(feature => feature.includes('shared location label')));
    assert.ok(result.sharedFeatures.some(feature => feature.includes('shared terms')));
    assert.ok(result.differingFeatures.some(feature => feature.includes('sources differ')));
  });

  it('scores unrelated stories as low confidence', () => {
    const left = makeNewsItem();
    const right = makeNewsItem({
      source: 'CNBC',
      title: 'Chip stocks rally after strong quarterly earnings guidance',
      link: 'https://example.test/cnbc/chips',
      pubDate: new Date('2026-04-07T12:00:00Z'),
      lat: 37.7749,
      lon: -122.4194,
      locationName: 'San Francisco',
      isAlert: false,
    });

    const result = compareNewsItems(left, right);

    assert.equal(result.confidence, 'low');
    assert.ok(result.similarity < 0.45, `expected low similarity, got ${result.similarity}`);
    assert.ok(result.differingFeatures.some(feature => feature.includes('geo offset')));
    assert.ok(result.differingFeatures.some(feature => feature.includes('time offset')));
  });
});

describe('scoreClusterCoherence', () => {
  it('returns the weakest pair and mean score for multi-item clusters', () => {
    const items = [
      makeNewsItem(),
      makeNewsItem({
        source: 'AP',
        title: 'Drone attack causes explosion near Odesa port overnight',
        link: 'https://example.test/ap/odesa',
        pubDate: new Date('2026-04-06T00:45:00Z'),
      }),
      makeNewsItem({
        source: 'BBC',
        title: 'Odesa blast reported after overnight strike on port facilities',
        link: 'https://example.test/bbc/odesa',
        pubDate: new Date('2026-04-06T01:20:00Z'),
      }),
    ];

    const coherence = scoreClusterCoherence(items);

    assert.equal(coherence.comparisonCount, 3);
    assert.equal(coherence.confidence, 'high');
    assert.ok(coherence.coherence >= 0.7, `expected coherent cluster, got ${coherence.coherence}`);
    assert.ok(coherence.weakestPair);
  });

  it('treats a singleton cluster as fully coherent', () => {
    const coherence = scoreClusterCoherence([makeNewsItem()]);
    assert.equal(coherence.coherence, 1);
    assert.equal(coherence.comparisonCount, 0);
    assert.equal(coherence.weakestPair, null);
  });
});

describe('buildEventComparisonEnvelope', () => {
  it('emits a stable bridge object without leaking extra structure', () => {
    const left = makeNewsItem();
    const right = makeNewsItem({
      source: 'AP',
      title: 'Drone attack causes explosion near Odesa port overnight',
      link: 'https://example.test/ap/odesa',
    });

    const envelope = buildEventComparisonEnvelope(left, right);

    assert.equal(envelope.envelopeType, 'wm.event_comparison.v1');
    assert.equal(envelope.meta.generatedBy, 'wm.event_comparison');
    assert.ok(envelope.leftEvent.id.startsWith('evt-'));
    assert.ok(envelope.rightEvent.id.startsWith('evt-'));
    assert.equal(envelope.leftEvent.title, left.title);
    assert.equal(envelope.rightEvent.source, right.source);
    assert.ok(typeof envelope.comparison.similarity === 'number');
  });
});
