import * as Twoslash from "fumadocs-twoslash/ui";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import {
  BookOpen,
  Boxes,
  CalendarClock,
  CloudUpload,
  Database,
  FlaskConical,
  Fingerprint,
  FolderInput,
  Globe,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Mail,
  Megaphone,
  Network,
  Package,
  Plug,
  Radio,
  Repeat,
  Rocket,
  Route,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  SquareFunction,
  Terminal,
  TriangleAlert,
  Waves,
  Workflow,
} from "lucide-react";
import type { MDXComponents } from "mdx/types";

import { PlateCard, PlateCards } from "./plate-card";

// The icons a page may pass to `<Card icon={<Rocket />}>`. Add one here before using it.
const icons = {
  BookOpen,
  Boxes,
  CalendarClock,
  CloudUpload,
  Database,
  Fingerprint,
  FlaskConical,
  FolderInput,
  Globe,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Mail,
  Megaphone,
  Network,
  Package,
  Plug,
  Radio,
  Repeat,
  Rocket,
  Route,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  SquareFunction,
  Terminal,
  TriangleAlert,
  Waves,
  Workflow,
};

// Registered once so every page can use them without importing.
export const getMDXComponents = (components?: MDXComponents) =>
  ({
    ...defaultMdxComponents,
    ...Twoslash,
    ...icons,
    Callout,
    Card,
    Cards,
    File,
    Files,
    Folder,
    PlateCard,
    PlateCards,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    ...components,
  }) satisfies MDXComponents;

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
