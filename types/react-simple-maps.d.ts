declare module "react-simple-maps" {
  import type { ComponentType, ReactNode } from "react";

  type MapGeography = {
    rsmKey: string;
    properties?: { name?: string; [key: string]: unknown };
    [key: string]: unknown;
  };

  export const ComposableMap: ComponentType<Record<string, unknown>>;
  export const Geographies: ComponentType<{
    geography: unknown;
    children: (value: { geographies: MapGeography[] }) => ReactNode;
    [key: string]: unknown;
  }>;
  export const Geography: ComponentType<Record<string, unknown>>;
  export const ZoomableGroup: ComponentType<Record<string, unknown>>;
}
