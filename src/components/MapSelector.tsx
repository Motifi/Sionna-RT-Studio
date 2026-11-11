/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CloudDownload, Search } from 'lucide-react';
import { useI18n } from '../i18n';
import type { GeoAnchor } from '../types';
import { RequestTimeoutError, withRequestTimeout } from '../utils';

interface MapSelectorProps {
  anchor: GeoAnchor;
  setAnchor: (anchor: GeoAnchor) => void;
  onDownloadOSM: (bounds: L.LatLngBounds) => void;
  isLoading: boolean;
  downloadProgress: string;
  mode: 'replace' | 'merge';
  onModeChange: (mode: 'replace' | 'merge') => void;
}

const field = 'min-h-9 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--ink-750)] px-2.5 py-1.5 text-sm';

export function MapSelector({ anchor, setAnchor, onDownloadOSM, isLoading, downloadProgress, mode, onModeChange }: MapSelectorProps) {
  const { t } = useI18n();
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const selection = useRef<L.Rectangle | null>(null);
  const updateAnchor = useRef(setAnchor);
  updateAnchor.current = setAnchor;

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<'missing' | 'timeout' | 'network' | null>(null);
  const [boxSizeM, setBoxSizeM] = useState(400);
  const bounds = useMemo(() => {
    const latDelta = boxSizeM / 2 / 111320;
    const lonDelta = latDelta / Math.cos(anchor.latitude * Math.PI / 180);
    return L.latLngBounds(
      [anchor.latitude - latDelta, anchor.longitude - lonDelta],
      [anchor.latitude + latDelta, anchor.longitude + lonDelta],
    );
  }, [anchor.latitude, anchor.longitude, boxSizeM]);
  const latestBounds = useRef(bounds);
  latestBounds.current = bounds;
  const fittedBounds = useRef<L.LatLngBounds | null>(null);

  useEffect(() => {
    const container = mapContainer.current;
    if (!container) return;

    const map = L.map(container, { center: latestBounds.current.getCenter(), zoom: 16, zoomAnimation: false });
    mapRef.current = map;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map);
    selection.current = L.rectangle(latestBounds.current, {
      color: '#cc785c', weight: 1.5, fillOpacity: 0.08, dashArray: '4, 4', interactive: false,
    }).addTo(map);
    map.on('click', ({ latlng }) => updateAnchor.current({ latitude: latlng.lat, longitude: latlng.lng }));

    // The dialog can reopen at a new size or with an anchor changed while it was closed.
    const resizeObserver = new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return;
      map.invalidateSize({ animate: false });
      if (fittedBounds.current !== latestBounds.current) {
        map.fitBounds(latestBounds.current, { padding: [24, 24], animate: false });
        fittedBounds.current = latestBounds.current;
      }
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      selection.current = null;
      fittedBounds.current = null;
    };
  }, []);

  useEffect(() => {
    const controls = [
      ['.leaflet-control-zoom-in', t('Zoom in', '放大地图')],
      ['.leaflet-control-zoom-out', t('Zoom out', '缩小地图')],
    ];
    for (const [selector, label] of controls) {
      const button = mapContainer.current?.querySelector(selector);
      button?.setAttribute('title', label);
      button?.setAttribute('aria-label', label);
    }
  }, [t]);

  useEffect(() => {
    selection.current?.setBounds(bounds);
    if (mapRef.current && mapContainer.current?.clientWidth) {
      mapRef.current.fitBounds(bounds, { padding: [24, 24], animate: false });
      fittedBounds.current = bounds;
    }
  }, [bounds]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query || searching) return;
    setSearchError(null);
    setSearching(true);
    try {
      const results = await withRequestTimeout(15_000, async signal => {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`,
          { signal },
        );
        if (!response.ok) throw new Error('Location search failed');
        return await response.json() as { lat: string; lon: string }[];
      });
      const latitude = Number(results[0]?.lat);
      const longitude = Number(results[0]?.lon);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) updateAnchor.current({ latitude, longitude });
      else setSearchError('missing');
    } catch (error) {
      setSearchError(error instanceof RequestTimeoutError ? 'timeout' : 'network');
    } finally {
      setSearching(false);
    }
  };

  return <div id="map-selection-sub" className="space-y-3">
    <form onSubmit={search} className="flex items-center gap-2">
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{t('Find a location', '查找地点')}</span>
        <Search size={15} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-mid)]" />
        <input id="map-location-query" type="text" className={`${field} pl-8`} value={searchQuery} disabled={searching}
          onChange={event => setSearchQuery(event.target.value)}
          placeholder={t('City, street, or coordinates', '城市、街道或坐标')} />
      </label>
      <button id="btn-trigger-nom-search" type="submit" disabled={searching || !searchQuery.trim()}
        className="btn-quiet min-h-9 cursor-pointer whitespace-nowrap px-3 py-1.5 text-sm disabled:cursor-not-allowed">
        {searching ? t('Searching…', '正在搜索…') : t('Locate', '定位')}
      </button>
    </form>
    {searchError && <p role="status" className="rounded-lg bg-[var(--accent-soft)] p-2 text-xs text-[var(--bad)]">
      {searchError === 'missing' && t('Place not found. Try another address or coordinates.', '未找到地点。请尝试其他地址或坐标。')}
      {searchError === 'timeout' && t('Nominatim timed out. Check your connection and retry.', 'Nominatim 请求超时。请检查网络后重试。')}
      {searchError === 'network' && t('Location search failed. Check your connection and retry.', '地点搜索失败。请检查网络后重试。')}
    </p>}
    <div className="relative h-[clamp(12rem,44dvh,25rem)] overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--ink-750)]">
      <div ref={mapContainer} aria-label={t('OpenStreetMap area selection', 'OpenStreetMap 选区')} className="z-1 h-full w-full" />
    </div>
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-[var(--text-mid)]">
      <span>{t('Click the map to move the selection.', '点击地图移动选区。')}</span>
      <span className="readout" title={t('Selection center, latitude and longitude', '选区中心经纬度')}>
        {anchor.latitude.toFixed(5)}°, {anchor.longitude.toFixed(5)}°
      </span>
    </div>
    <label className="block space-y-1 text-xs font-semibold" htmlFor="slider-box-size">
      <span className="flex items-center justify-between gap-2">
        {t('Selection size', '选区大小')}
        <span className="readout">{boxSizeM} m × {boxSizeM} m</span>
      </span>
      <input id="slider-box-size" type="range" min="100" max="2000" step="50"
        className="w-full cursor-ew-resize accent-[var(--accent)]" value={boxSizeM}
        onChange={event => setBoxSizeM(event.target.valueAsNumber)} />
    </label>
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs font-semibold">{t('Import mode', '导入方式')}
        <select className={field} value={mode} disabled={isLoading}
          onChange={event => onModeChange(event.target.value === 'merge' ? 'merge' : 'replace')}>
          <option value="replace">{t('Replace scene', '替换场景')}</option>
          <option value="merge">{t('Merge new objects', '合并新对象')}</option>
        </select>
      </label>
      <button id="btn-trigger-gis-downloader" type="button" disabled={isLoading} onClick={() => onDownloadOSM(bounds)}
        className="btn-signal flex min-h-9 cursor-pointer items-center justify-center gap-1.5 px-3 py-1.5 text-sm disabled:cursor-not-allowed">
        <CloudDownload size={16} aria-hidden="true" />
        {isLoading ? t('Downloading…', '正在下载…') : t('Import selected area', '导入所选区域')}
      </button>
    </div>
    {(isLoading || downloadProgress) && <p role="status" className="panel-flush p-2.5 text-xs text-[var(--text-mid)]">
      {downloadProgress || t('Retrieving map geometry…', '正在获取地图几何…')}
    </p>}
  </div>;
}
