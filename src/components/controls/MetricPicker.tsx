import { useMemo, useState } from 'react';

import { useAppStore } from '../../state/useAppStore.ts';

/**
 * Layer > Group > Metric navigation.
 *
 * Metric layers render as a single-select tree (only one thing can color the
 * map); overlay layers render as independent checkboxes (many at once). The
 * search box flattens everything, which is what keeps this usable once the
 * registry holds hundreds of metrics rather than nine.
 */
export function MetricPicker() {
  const region = useAppStore((s) => s.region());
  const metricId = useAppStore((s) => s.metricId);
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  const setMetric = useAppStore((s) => s.setMetric);
  const overlays = useAppStore((s) => s.overlays);
  const toggleOverlay = useAppStore((s) => s.toggleOverlay);
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();

  const layers = useMemo(() => {
    if (!region) return [];
    return region.layers
      .map((layer) => ({
        ...layer,
        groups: (layer.groups ?? [])
          .map((g) => ({
            ...g,
            metrics: g.metrics.filter(
              (m) => !q || m.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q),
            ),
          }))
          .filter((g) => g.metrics.length > 0),
      }))
      .filter((l) => l.kind === 'overlay' || l.groups.length > 0);
  }, [region, q]);

  if (!region) return null;

  return (
    <div className="picker">
      <input
        className="search"
        type="search"
        placeholder="Search metrics…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {layers.map((layer) => (
        <section key={layer.id} className="layer">
          <h3>
            {layer.label}
            {layer.kind === 'overlay' && <span className="tag">overlay</span>}
          </h3>

          {layer.kind === 'overlay' ? (
            <label className="row overlay">
              <input
                type="checkbox"
                checked={overlays.has(layer.id)}
                onChange={() => toggleOverlay(layer.id)}
              />
              <span>Show {layer.label.toLowerCase()}</span>
            </label>
          ) : (
            layer.groups.map((group) => (
              <div key={group.id} className="group">
                <h4>{group.label}</h4>
                {group.metrics.map((m) => {
                  // A metric may not exist at the current geography -- elections
                  // are precinct-level, census data is not. Say so rather than
                  // silently rendering an empty map.
                  const available = m.geoLevels.includes(geoLevelId ?? '');
                  return (
                    <button
                      key={m.id}
                      className={`row metric${m.id === metricId ? ' active' : ''}${
                        available ? '' : ' unavailable'
                      }`}
                      onClick={() => setMetric(m.id)}
                      title={
                        available
                          ? m.description
                          : `Not available at this geography (${m.geoLevels.join(', ')})`
                      }
                    >
                      <span>{m.label}</span>
                      <span className="years">{m.years.length}y</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </section>
      ))}
      {layers.length === 0 && <p className="empty">No metrics match “{query}”.</p>}
    </div>
  );
}
