// three.js ships no type declarations of its own, and only the `three`
// package itself is approved for the attack map's globe (no @types/three).
// These declare the few parts components/platform/security-map/
// globe-renderer.ts uses, written from the installed three@0.187.0 source
// (src/renderers/WebGLRenderer.js, src/core/*, src/materials/*,
// src/objects/*, src/cameras/PerspectiveCamera.js, src/constants.js). Add a
// part here only after reading it in the installed package.
declare module 'three' {
  export const REVISION: string;
  export const FrontSide: 0;
  export const BackSide: 1;
  export const NormalBlending: 1;
  export const AdditiveBlending: 2;
  export const DynamicDrawUsage: 35048;
  export const SRGBColorSpace: 'srgb';

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
  }

  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    set(x: number, y: number): this;
  }

  export class Euler {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
  }

  export class Object3D {
    position: Vector3;
    rotation: Euler;
    scale: Vector3;
    visible: boolean;
    frustumCulled: boolean;
    renderOrder: number;
    add(...objects: Object3D[]): this;
    remove(...objects: Object3D[]): this;
  }

  export class Group extends Object3D {}
  export class Scene extends Object3D {}

  export class PerspectiveCamera extends Object3D {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    aspect: number;
    fov: number;
    updateProjectionMatrix(): void;
    lookAt(x: number, y: number, z: number): void;
  }

  export type TypedArray = Float32Array | Uint16Array | Uint32Array;

  export class BufferAttribute {
    constructor(array: TypedArray, itemSize: number, normalized?: boolean);
    array: TypedArray;
    itemSize: number;
    count: number;
    set needsUpdate(value: boolean);
    setUsage(usage: number): this;
  }

  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): this;
    getAttribute(name: string): BufferAttribute;
    setIndex(index: BufferAttribute | null): this;
    setDrawRange(start: number, count: number): void;
    dispose(): void;
  }

  export class SphereGeometry extends BufferGeometry {
    constructor(
      radius?: number,
      widthSegments?: number,
      heightSegments?: number,
      phiStart?: number,
      phiLength?: number,
      thetaStart?: number,
      thetaLength?: number,
    );
  }

  export interface IUniform<T = unknown> {
    value: T;
  }

  export class Texture {
    colorSpace: string;
    needsUpdate: boolean;
    dispose(): void;
  }

  export class CanvasTexture extends Texture {
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas);
  }

  export class Material {
    transparent: boolean;
    depthWrite: boolean;
    depthTest: boolean;
    blending: number;
    side: number;
    dispose(): void;
  }

  export interface ShaderMaterialParameters {
    uniforms?: Record<string, IUniform>;
    vertexShader?: string;
    fragmentShader?: string;
    transparent?: boolean;
    depthWrite?: boolean;
    depthTest?: boolean;
    blending?: number;
    side?: number;
  }

  export class ShaderMaterial extends Material {
    constructor(parameters?: ShaderMaterialParameters);
    uniforms: Record<string, IUniform>;
  }

  export interface SpriteMaterialParameters {
    map?: Texture | null;
    transparent?: boolean;
    depthWrite?: boolean;
    depthTest?: boolean;
    opacity?: number;
  }

  export class SpriteMaterial extends Material {
    constructor(parameters?: SpriteMaterialParameters);
    opacity: number;
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    material: Material;
  }

  export class Points extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    material: Material;
  }

  export class Sprite extends Object3D {
    constructor(material?: SpriteMaterial);
    center: Vector2;
    material: SpriteMaterial;
  }

  export interface WebGLRendererParameters {
    canvas?: HTMLCanvasElement;
    alpha?: boolean;
    antialias?: boolean;
    depth?: boolean;
    stencil?: boolean;
    premultipliedAlpha?: boolean;
    powerPreference?: 'default' | 'high-performance' | 'low-power';
    failIfMajorPerformanceCaveat?: boolean;
  }

  export class WebGLRenderer {
    constructor(parameters?: WebGLRendererParameters);
    domElement: HTMLCanvasElement;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setClearColor(color: number, alpha?: number): void;
    render(scene: Object3D, camera: PerspectiveCamera): void;
    dispose(): void;
    forceContextLoss(): void;
  }
}
