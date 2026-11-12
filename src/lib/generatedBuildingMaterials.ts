import type { MeshStandardMaterialParameters } from 'three';
import type { BuildingFootprint } from '../types';

export function generatedBuildingMaterial(
  object: Pick<BuildingFootprint, 'type' | 'material' | 'floor'>,
): MeshStandardMaterialParameters | undefined {
  switch (object.type) {
    case 'generated_facade':
      return { color: object.material === 'itu_brick' ? 0xa46955 : 0xd3ccc0, roughness: 0.9 };
    case 'generated_glazing':
      return { color: 0x6a9eb5, roughness: 0.18, transparent: true, opacity: 0.54, depthWrite: false };
    case 'generated_slab':
      return { color: object.floor === 'Roof' ? 0x757671 : 0xbdb6ab, roughness: 0.96 };
    case 'generated_partition':
      return { color: 0xe1d9cb, roughness: 0.94 };
    case 'generated_stair':
      return { color: 0xa8a29a, roughness: 0.89 };
    case 'generated_trim':
      return { color: 0x36434a, metalness: 0.3, roughness: 0.65 };
    case 'generated_entry':
      return { color: 0x566970, metalness: 0.24, roughness: 0.67 };
    case 'generated_roof_equipment':
      return { color: 0x525c60, metalness: 0.18, roughness: 0.7 };
    default:
      return undefined;
  }
}
