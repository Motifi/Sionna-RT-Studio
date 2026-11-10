/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { useI18n } from '../i18n';
import { BuildingFootprint, GeoAnchor, MaterialConfig, ScatteringPattern } from '../types';
import { Search, Filter, Building, Compass, Milestone, TreePine, Droplet, Hash, Ruler, Layers } from 'lucide-react';

interface GeographyPanelProps {
  buildings: BuildingFootprint[];
  anchor: GeoAnchor;
  materialIds: string[];
  materialConfigs: MaterialConfig[];
  onMaterialChange: (cfg: MaterialConfig) => void;
}

export function GeographyPanel({ buildings, anchor, materialIds, materialConfigs, onMaterialChange }: GeographyPanelProps) {
  const { t, locale } = useI18n();
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  // Compute stats on current geographic twin
  const stats = useMemo(() => {
    const totalCount = buildings.length;
    const structures = buildings.filter((b) => b.category === 'building');
    const buildingCount = structures.length;
    const roadCount = buildings.filter((b) => b.category === 'infrastructure').length;
    const parkCount = buildings.filter((b) => b.category === 'terrain').length;
    const waterCount = buildings.filter((b) => b.category === 'water').length;

    let totalHeightSum = 0;
    let maxBuildingHeight = 0;
    let concreteCount = 0;
    let glassCount = 0;
    let brickCount = 0;
    let metalCount = 0;

    for (const b of structures) {
      totalHeightSum += b.height;
      if (b.height > maxBuildingHeight) {
        maxBuildingHeight = b.height;
      }
      if (b.material === 'itu_concrete') concreteCount++;
      else if (b.material === 'itu_glass') glassCount++;
      else if (b.material === 'itu_brick') brickCount++;
      else if (b.material === 'itu_metal') metalCount++;
    }

    const averageHeight = buildingCount > 0 ? totalHeightSum / buildingCount : 0;

    return {
      totalCount,
      buildingCount,
      roadCount,
      parkCount,
      waterCount,
      averageHeight,
      maxBuildingHeight,
      materials: {
        concrete: concreteCount,
        glass: glassCount,
        brick: brickCount,
        metal: metalCount,
        others: Math.max(0, buildingCount - (concreteCount + glassCount + brickCount + metalCount)),
      },
    };
  }, [buildings]);

  // Filter structures list
  const filteredBuildings = useMemo(() => {
    return buildings.filter((b) => {
      // search match
      const label = `${b.id} ${b.type} ${b.material}`.toLowerCase();
      const matchesSearch = label.includes(searchTerm.toLowerCase());

      // category match
      const matchesCategory = categoryFilter === 'all' || b.category === categoryFilter;

      return matchesSearch && matchesCategory;
    });
  }, [buildings, searchTerm, categoryFilter]);

  // Map material text to human readable strings
  const getMaterialLabel = (mat: string) => {
    switch (mat) {
      case 'itu_concrete':
        return t('Standard Concrete', '标准混凝土');
      case 'itu_glass':
        return t('Sapphire Glass', '蓝宝石玻璃');
      case 'itu_brick':
        return t('Thermal Brick', '保温砖');
      case 'itu_metal':
        return t('Polished Metal', '抛光金属');
      default:
        return t('Dry Ground / Base', '干燥地面 / 基底');
    }
  };

  return (
    <div id="geography-insights-panel" className="panel p-5 flex flex-col gap-6 h-full overflow-y-auto">
      {/* Header section */}
      <div className="flex items-center gap-2 border-b border-[#e3e0d6] pb-3">
        <Compass className="w-5 h-5 text-[#cc785c] animate-spin-slow" />
        <div>
          <h3 className="panel-title">{t('Geographic Physical Twin Information', '地理场景信息')}</h3>
          <p className="text-[12px] text-[#6b6862] font-semibold">{t('Loaded Coordinates & Structure Classifications', '场景坐标和地物分类')}</p>
        </div>
      </div>

      {/* Anchor Meta Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6] flex flex-col gap-1">
          <span className="text-[11px] text-[#6b6862] font-bold">{t('Active Anchor Location', '当前坐标原点')}</span>
          <span className="text-[14px] font-mono font-bold text-[#141413]">
            {anchor.latitude.toFixed(6)}°N, {anchor.longitude.toFixed(6)}°E
          </span>
          <span className="text-[11px] text-green-500 font-bold font-mono">{t('WGS84 Reference Spherical EPSG:4326', 'WGS84 地理坐标系（EPSG:4326）')}</span>
        </div>

        <div className="bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6] flex flex-col gap-1">
          <span className="text-[11px] text-[#6b6862] font-bold">{t('Twin Bounding Extent', '场景范围')}</span>
          <span className="text-[14px] font-mono font-bold text-[#141413]">{t('~ 400m × 500m area', '约 400 米 × 500 米')}</span>
          <span className="text-[11px] text-[#cc785c] font-bold">{t('Local ENU Coordinates Anchored', '以该点为局部 ENU 坐标原点')}</span>
        </div>

        <div className="bg-[#f5f3ec] p-3 rounded border border-[#e3e0d6] flex flex-col gap-1">
          <span className="text-[11px] text-[#6b6862] font-bold">{t('Feature Population', '地物数量')}</span>
          <span className="text-[14px] font-mono font-bold text-[#141413]">
            {t(`${stats.totalCount} active nodes mapped`, `已载入 ${stats.totalCount} 个地物`)}
          </span>
          <span className="text-[11px] text-slate-600 font-bold">{t('Extruded & Rendered Layers', '拉伸建模与渲染图层')}</span>
        </div>
      </div>

      {/* Material editor — per-material scattering + EM overrides (Sionna RadioMaterial) */}
      {materialIds.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#cc785c]" />
            <h4 className="panel-title">{t('Material & Scattering Editor', '材料和散射设置')}</h4>
          </div>
          <p className="text-[12px] text-slate-600 leading-relaxed -mt-1">
            {t('Set the diffuse scattering coefficient, cross-polarization discrimination (XPD), and scattering pattern for each material. Changes apply when tracing the scene.', '逐种材料设置漫散射系数、交叉极化鉴别率（XPD）和散射方向图。修改会在射线追踪时生效。')}
          </p>
          <div className="flex flex-col gap-3">
            {materialIds.map((id) => {
              const cfg = materialConfigs.find((m) => m.id === id)
                ?? { id, scatteringCoefficient: 0, xpdCoefficient: 0, scatteringPattern: 'none' as ScatteringPattern };
              return (
                <div key={id} className="bg-[#f5f3ec] border border-[#e3e0d6] rounded p-3 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-bold text-slate-800">{getMaterialLabel(id)}</span>
                    <span className="text-[11px] font-mono text-slate-500">{id}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-slate-600 font-bold">{t('Scattering S', '散射系数 S')}: {cfg.scatteringCoefficient.toFixed(2)}</span>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        className="accent-[#cc785c] cursor-ew-resize"
                        value={cfg.scatteringCoefficient}
                        onChange={(e) => onMaterialChange({ ...cfg, scatteringCoefficient: parseFloat(e.target.value) })}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-slate-600 font-bold">XPD: {cfg.xpdCoefficient.toFixed(2)}</span>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        className="accent-[#cc785c] cursor-ew-resize"
                        value={cfg.xpdCoefficient}
                        onChange={(e) => onMaterialChange({ ...cfg, xpdCoefficient: parseFloat(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-slate-600 font-bold">{t('Scattering Pattern', '散射方向图')}</span>
                    <select
                      className="text-[14px] py-1.5 px-2 bg-white border border-[#e3e0d6] rounded text-slate-900 focus:outline-none focus:border-[#cc785c] cursor-pointer"
                      value={cfg.scatteringPattern}
                      onChange={(e) => onMaterialChange({ ...cfg, scatteringPattern: e.target.value as ScatteringPattern })}
                    >
                      <option value="none">{t('None (specular only)', '仅镜面反射')}</option>
                      <option value="lambertian">{t('Lambertian (uniform)', '朗伯散射')}</option>
                      <option value="directive">{t('Directive', '定向散射')}</option>
                      <option value="backscattering">{t('Backscattering', '后向散射')}</option>
                    </select>
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Numerical Metrics Cards */}
      <h4 className="eyebrow -mb-3">
         {t('Statistical Breakdown of Mapped Structures', '地物统计')}
      </h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#4a727e]">
            <Building className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">{t('Buildings', '建筑')}</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.buildingCount}</span>
          </div>
        </div>

        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-slate-600">
            <Milestone className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">{t('Roads', '道路')}</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.roadCount}</span>
          </div>
        </div>

        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#5f7f5a]">
            <TreePine className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">{t('Parks/Forests', '公园与林地')}</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.parkCount}</span>
          </div>
        </div>

        <div className="panel-flush p-3 flex items-center gap-3">
          <div className="p-2.5 bg-[#ebe7dc] border border-[#e3e0d6] rounded text-[#4a727e]">
            <Droplet className="w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] text-slate-600 font-bold">{t('Waterways', '水域')}</span>
            <span className="text-[20px] font-bold font-mono text-slate-900">{stats.waterCount}</span>
          </div>
        </div>
      </div>

      {/* Extrusion Height statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-[#f5f3ec] border border-[#e3e0d6] rounded p-4">
        <div className="flex flex-col gap-2">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Ruler className="w-3.5 h-3.5 text-[#cc785c]" /> {t('Extrusion Geometry Analysis', '建筑几何统计')}
          </h4>
          <div className="flex justify-between border-b border-[#e3e0d6] py-2 text-[14px]">
            <span className="text-slate-600 font-medium">{t('Average Building height:', '平均建筑高度：')}</span>
            <span className="font-bold font-mono text-slate-900">{stats.averageHeight.toFixed(1)} m</span>
          </div>
          <div className="flex justify-between border-b border-[#e3e0d6] py-2 text-[14px]">
            <span className="text-slate-600 font-medium">{t('Max Building height:', '最高建筑高度：')}</span>
            <span className="font-bold font-mono text-slate-900">{stats.maxBuildingHeight.toFixed(1)} m</span>
          </div>
          <div className="flex justify-between py-2 text-[14px]">
            <span className="text-slate-600 font-medium">{t('Approximate Volumetric Footprint:', '估算总体积：')}</span>
            <span className="font-bold font-mono text-[#cc785c]">
              {(stats.buildingCount * stats.averageHeight * 240).toLocaleString(locale, { maximumFractionDigits: 0 })} m³
            </span>
          </div>
        </div>

        {/* Material Distribution Bars */}
        <div className="flex flex-col gap-2">
          <h4 className="eyebrow flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5 text-[#cc785c]" /> {t('Material Classification Count', '材料分布')}
          </h4>

          {/* Concrete */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[13px] font-mono leading-none">
              <span className="text-slate-600">{t('Concrete', '混凝土')} ({stats.materials.concrete})</span>
              <span className="text-slate-600 font-bold">
                {stats.buildingCount > 0 ? ((stats.materials.concrete / stats.buildingCount) * 100).toFixed(0) : 0}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded bg-slate-100">
              <div
                className="h-full bg-slate-400 rounded"
                style={{ width: `${stats.buildingCount > 0 ? (stats.materials.concrete / stats.buildingCount) * 100 : 0}%` }}
              />
            </div>
          </div>

          {/* Glass */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[13px] font-mono leading-none">
              <span className="text-slate-600">{t('Sapphire Glass', '蓝宝石玻璃')} ({stats.materials.glass})</span>
              <span className="text-slate-600 font-bold">
                {stats.buildingCount > 0 ? ((stats.materials.glass / stats.buildingCount) * 100).toFixed(0) : 0}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded bg-slate-100">
              <div
                className="h-full bg-[#4a727e] rounded"
                style={{ width: `${stats.buildingCount > 0 ? (stats.materials.glass / stats.buildingCount) * 100 : 0}%` }}
              />
            </div>
          </div>

          {/* Brick */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[13px] font-mono leading-none">
              <span className="text-slate-600">{t('Terracotta Brick', '陶土砖')} ({stats.materials.brick})</span>
              <span className="text-slate-600 font-bold">
                {stats.buildingCount > 0 ? ((stats.materials.brick / stats.buildingCount) * 100).toFixed(0) : 0}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded bg-slate-100">
              <div
                className="h-full bg-[#b2624a] rounded"
                style={{ width: `${stats.buildingCount > 0 ? (stats.materials.brick / stats.buildingCount) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Map Filter & Table Directory */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
          <h4 className="eyebrow">
            {t('Coordinate Node Classification Directory', '地物分类目录')}
          </h4>

          {/* Search Table and filters */}
          <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:flex-initial">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                type="text"
                placeholder={t('Search by ID/Type...', '按编号或类型搜索…')}
                className="text-[14px] bg-[#f5f3ec] border border-[#e3e0d6] rounded pl-8 pr-3 py-1.5 text-slate-900 placeholder-slate-500 focus:outline-none focus:border-[#cc785c] w-full md:w-48"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            {/* Category selection filter dropdown */}
            <div className="flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-slate-600" />
              <select
                className="text-[13px] bg-[#f5f3ec] border border-[#e3e0d6] rounded px-2 py-1.5 text-slate-900 font-medium focus:outline-none focus:border-[#cc785c]"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="all">{t('All Layers', '全部图层')}</option>
                <option value="building">{t('Buildings', '建筑')}</option>
                <option value="infrastructure">{t('Infrastructure', '基础设施')}</option>
                <option value="terrain">{t('Parks & Terrain', '公园与地形')}</option>
                <option value="water">{t('Water Bodies', '水域')}</option>
              </select>
            </div>
          </div>
        </div>

        {/* List table */}
        <div className="border border-[#e3e0d6] rounded text-[14px] overflow-hidden max-h-[200px] overflow-y-auto bg-[#f5f3ec]">
          <table className="w-full text-left font-mono">
            <thead className="bg-[#ffffff] border-b border-[#e3e0d6] sticky top-0 text-[11px] text-slate-600 font-bold">
              <tr>
                <th className="py-2.5 px-3">{t('Structure ID / Layer', '地物编号 / 图层')}</th>
                <th className="py-2.5 px-3">{t('Classification', '类别')}</th>
                <th className="py-2.5 px-3">{t('Geo-Height', '高度')}</th>
                <th className="py-2.5 px-3">{t('Surface Material', '表面材料')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e3e0d6] text-[13px] text-[#6b6862]">
              {filteredBuildings.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 px-3 text-center text-slate-600">
                    {t('No nodes matching your query criteria.', '没有找到符合条件的地物。')}
                  </td>
                </tr>
              ) : (
                filteredBuildings.map((b) => (
                  <tr key={b.id} className="hover:bg-[#ebe7dc]/40 transition duration-150 text-slate-700">
                    <td className="py-2 px-3 flex items-center gap-2">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          b.category === 'building'
                            ? 'bg-[#4a727e]'
                            : b.category === 'infrastructure'
                            ? 'bg-slate-400'
                            : b.category === 'terrain'
                            ? 'bg-[#5f7f5a]'
                            : 'bg-[#4a727e]'
                        }`}
                      />
                      <span className="font-sans font-bold">{b.id}</span>
                    </td>
                    <td className="py-2 px-3 text-slate-600 capitalize">{b.type || t('Undefined', '未分类')}</td>
                    <td className="py-2 px-3 text-slate-600 font-mono font-semibold">
                      {b.category === 'infrastructure' || b.category === 'terrain' || b.category === 'water' ? t('Ground Plan', '地面要素') : `${b.height.toFixed(1)} m`}
                    </td>
                    <td className="py-2 px-3 select-all cursor-copy text-[14px] text-slate-600">
                      {getMaterialLabel(b.material)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
