import c1 from "./us-states-1";
import c2 from "./us-states-2";
import c3 from "./us-states-3";
import c4 from "./us-states-4";
import c5 from "./us-states-5";
import c6 from "./us-states-6";
import c7 from "./us-states-7";

const atlas = JSON.parse(c1 + c2 + c3 + c4 + c5 + c6 + c7) as {
  viewBox: string;
  projection: string;
  paths: Record<string, string>;
  centroids: Record<string, [number, number]>;
};

export default atlas;
