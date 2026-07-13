import type { Benefit, DatasetManifest } from "@honor/core";
import rawBenefits from "../public/data/search-index.pilot-sample-20260712.json";
import rawManifest from "../public/data/manifest.json";

export const benefits = rawBenefits as Benefit[];
export const datasetManifest = rawManifest as DatasetManifest;

export const benefitById = new Map(benefits.map((benefit) => [benefit.id, benefit]));
