import { useMemo } from 'react';

import { indexAgainst, useBaselineOverride, useMetricData } from '../../data/useMetricData.ts';
import { findMetric } from '../../data/types.ts';
import { baselineNoun, useBaselineTarget } from '../../lib/baseline.ts';
import { formatDelta, formatIndex, formatIndexDelta, formatValue } from '../../lib/format.ts';
import { buildLeaderboard, type LeaderboardRow } from '../../lib/stats/leaderboard.ts';
import { useAppStore } from '../../state/useAppStore.ts';

/**
 * The Top 10 for whatever is currently selected.
 *
 * Follows the map rather than owning a scope of its own: region, geo level,
 * metric, year and view mode all come from the same store the choropleth reads,
 * so "US / states / population / index" ranks states by index and "Columbus /
 * places / rent / raw" ranks places by dollars. The only two questions it adds
 * are which END of the ordering to show, and whether to rank the level or the
 * change across the metric's whole span.
 */
export function TopListPanel() {
  const region = useAppStore((s) => s.region());
  const geoLevelId = useAppStore((s) => s.geoLevelId);
  const metricId = useAppStore((s) => s.metricId);
  const year = useAppStore((s) => s.year);
  const viewMode = useAppStore((s) => s.viewMode);
  const basis = useAppStore((s) => s.topBasis);
  const direction = useAppStore((s) => s.topDirection);
  const showImprecise = useAppStore((s) => s.topShowImprecise);
  const open = useAppStore((s) => s.topOpen);
  const setBasis = useAppStore((s) => s.setTopBasis);
  const setDirection = useAppStore((s) => s.setTopDirection);
  const setShowImprecise = useAppStore((s) => s.setTopShowImprecise);
  const setOpen = useAppStore((s) => s.setTopOpen);
  const setHovered = useAppStore((s) => s.setHovered);
  const setSelected = useAppStore((s) => s.setSelected);
  const selectedGeoid = useAppStore((s) => s.selectedGeoid);

  const target = useBaselineTarget();
  const { file } = useMetricData();
  const { series: override } = useBaselineOverride(metricId);

  const metric = region && metricId ? findMetric(region, metricId) : undefined;
  const level = region?.geoLevels.find((g) => g.id === geoLevelId);

  // The index reaches the leaderboard only through this closure, so an ancestor
  // baseline repins the list exactly when it repins the map -- the two can
  // never end up showing different meanings of "100" side by side.
  const board = useMemo(() => {
    if (!file || year == null) return null;
    return buildLeaderboard(file, {
      year,
      measure: viewMode === 'index' ? 'index' : 'raw',
      basis,
      direction,
      excludeImprecise: !showImprecise,
      indexAt: (yi, i) =>
        override
          ? indexAgainst(file.values[yi]?.[i] ?? null, override.get(file.years[yi]!))
          : (file.index[yi]?.[i] ?? null),
    });
  }, [file, year, viewMode, basis, direction, showImprecise, override]);

  if (!metric || !board) return null;

  const noun = baselineNoun(target);
  const isIndex = viewMode === 'index';
  const singleYear = file != null && file.years.length < 2;
  const heading = `${direction === 'highest' ? 'Top' : 'Bottom'} ${board.rows.length || 10}`;

  const headline = (r: LeaderboardRow): string => {
    if (basis === 'level') return isIndex ? formatIndex(r.index) : formatValue(r.value, metric.unit);
    return isIndex ? formatIndexDelta(r.sortValue) : formatDelta(r.sortValue, metric.unit);
  };

  /*
   * The second line always carries the other half of the story: the raw dollars
   * behind an index, or the two endpoints behind a change. A leaderboard
   * showing only its own sort key invites the reader to take a rank for a fact.
   */
  const detail = (r: LeaderboardRow): string => {
    if (basis === 'level') {
      return isIndex ? formatValue(r.value, metric.unit) : `${formatIndex(r.index)} of ${noun}`;
    }
    return isIndex
      ? `${formatIndex(r.from?.index ?? null)} → ${formatIndex(r.index)}`
      : `${formatValue(r.from?.value ?? null, metric.unit)} → ${formatValue(r.value, metric.unit)}`;
  };

  const subtitle = () => {
    const what = `${level?.label ?? 'areas'} by ${metric.label.toLowerCase()}`;
    const when =
      basis === 'delta' && board.span
        ? `, change ${board.span[0]}–${board.span[1]}`
        : year != null
          ? `, ${year}`
          : '';
    return `${what}${when}${isIndex ? ` (vs ${noun})` : ''}`;
  };

  return (
    <aside className={open ? 'toplist' : 'toplist collapsed'}>
      <header className="toplist-head">
        <button
          className="toplist-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={open ? 'Hide the list' : 'Show the list'}
        >
          {open ? '›' : '‹'}
        </button>
        <div className="toplist-title">
          <h2>{heading}</h2>
          {open && <p className="muted">{subtitle()}</p>}
        </div>
      </header>

      {open && (
        <>
          <div className="segmented small">
            <button
              className={basis === 'level' ? 'active' : ''}
              onClick={() => setBasis('level')}
              title="Rank by the value in the selected year"
            >
              Value
            </button>
            <button
              className={basis === 'delta' ? 'active' : ''}
              onClick={() => setBasis('delta')}
              disabled={singleYear}
              title={
                singleYear
                  ? 'This metric has only one year of data'
                  : isIndex
                    ? 'Rank by the change in index points across the full span'
                    : 'Rank by the change in value across the full span (not inflation-adjusted)'
              }
            >
              Change
            </button>
          </div>

          <div className="segmented small">
            <button
              className={direction === 'highest' ? 'active' : ''}
              onClick={() => setDirection('highest')}
              title="Largest first: highest value, or biggest increase"
            >
              Highest
            </button>
            <button
              className={direction === 'lowest' ? 'active' : ''}
              onClick={() => setDirection('lowest')}
              title="Smallest first: lowest value, or biggest decrease"
            >
              Lowest
            </button>
          </div>

          {board.rows.length === 0 ? (
            <p className="muted toplist-empty">No areas have data for this selection.</p>
          ) : (
            <ol className="toplist-rows">
              {board.rows.map((r) => (
                <li
                  key={r.geoid}
                  className={r.geoid === selectedGeoid ? 'active' : ''}
                  onMouseEnter={() => setHovered(r.geoid)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => setSelected(selectedGeoid === r.geoid ? null : r.geoid)}
                >
                  <span className="toplist-pos">{r.position}</span>
                  <span className="toplist-name" title={r.name}>
                    {r.name}
                    <small>{detail(r)}</small>
                  </span>
                  <span
                    className={
                      basis === 'delta'
                        ? `toplist-value ${r.sortValue >= 0 ? 'above' : 'below'}`
                        : 'toplist-value'
                    }
                  >
                    {headline(r)}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <footer className="toplist-foot">
            <span>
              of {board.total.toLocaleString()} with data
              {basis === 'delta' ? ' in both years' : ''}
            </span>

            {/*
              Rule 5: the untrimmed top-10-by-change is dominated by townships of
              a few hundred people whose swing is sampling error. Excluding them
              silently would be its own kind of lie, so the count is always
              stated and the exclusion is always reversible.
            */}
            {board.impreciseCount > 0 && (
              <label className="toplist-imprecise">
                <input
                  type="checkbox"
                  checked={showImprecise}
                  onChange={(e) => setShowImprecise(e.target.checked)}
                />
                <span>
                  {showImprecise
                    ? `Including ${board.impreciseCount} imprecise`
                    : `${board.impreciseCount} excluded as imprecise`}
                  <small>
                    Margin of error above 15%, almost always small populations — an apparent swing
                    there is survey noise.
                  </small>
                </span>
              </label>
            )}

            {level?.tilesRegion === false && (
              <span className="toplist-note">
                {level.label} do not cover the whole region, so unincorporated areas are not ranked.
              </span>
            )}
          </footer>
        </>
      )}
    </aside>
  );
}
