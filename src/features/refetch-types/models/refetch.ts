import type { LocalApp } from "../../../entities/microfrontend/index.ts";

export type TypesConsumer = Pick<LocalApp, "folder" | "typesFolder" | "remotes" | "consumeTypes">;

export type Remote = LocalApp["remotes"][number];

export type TypesRoot = { folder: string; real: string };

export type PathEntry = { file: string; link?: { id: string; parent?: string; listed: boolean } };
