/** Counters, declared as a tool plug-in: the README's example. */

import type { LayoutCardField, Manifest, Tool } from "../../src/manifest.js";

/** A layout's part drawing one field. */
const field = (key: string): LayoutCardField => ({ type: "field", props: { field: key } });

export function countersTool(): Tool {
  return {
    key: "counter_group",
    name: { en: "Counters" },
    instance_name: { en: "Counter group" },
    icon: "gauge",
    fields: [{ key: "description", name: { en: "Description" }, kind: "text" }],
    layouts: {
      lists: [
        {
          kind: "grid",
          card: {
            type: "card",
            children: [
              { type: "items", props: { item: "counter", fields: ["name", "count"], limit: 4, tint: "color" } },
              field("name"),
              { type: "stack", props: { tone: "muted" }, children: [field("description")] },
            ],
          },
        },
        { kind: "table", columns: ["name", "description", "updated_at"] },
      ],
      detail: {
        header: [{ type: "stack", props: { direction: "row", gap: "sm", align: "start" }, children: [field("name"), { type: "actions" }] }],
        main: [field("description"), { type: "relations" }],
        side: [{ type: "section", children: [{ type: "properties" }] }, { type: "byline" }],
      },
    },
    items: [
      {
        key: "counter",
        name: { en: "Counter" },
        fields: [
          {
            key: "count",
            name: { en: "Count" },
            kind: "counter",
            counter: { min: "min", max: "max", step: "step", initial: "initial_count" },
          },
          { key: "min", name: { en: "Minimum" }, kind: "number" },
          { key: "max", name: { en: "Maximum" }, kind: "number" },
          { key: "step", name: { en: "Step" }, kind: "number", default: 1, required: true },
          { key: "initial_count", name: { en: "Starting count" }, kind: "number", default: 0, required: true },
          { key: "color", name: { en: "Colour" }, kind: "color", default: "random" },
          {
            key: "view_mode",
            name: { en: "Look" },
            kind: "select",
            default: "number",
            required: true,
            options: [
              { value: "number", label: { en: "Number" } },
              { value: "bar", label: { en: "Progress bar" } },
              { value: "clock", label: { en: "Segmented clock" } },
            ],
          },
        ],
        checks: [
          { field: "min", at_most: { field: "max" } },
          { field: "step", above: 0 },
        ],
        layouts: {
          lists: [
            {
              kind: "grid",
              card: { type: "card", props: { tint: "color" }, children: [field("name"), field("count")] },
              displays: { count: { from: "view_mode" } },
              presets: [
                { slug: "by-name", name: { en: "By name" }, sort: [{ field: "name" }] },
                { slug: "by-count", name: { en: "By count" }, sort: [{ field: "count", dir: "desc" }, { field: "name" }] },
              ],
            },
            { kind: "table", columns: ["name", "count", "min", "max"], displays: { count: { from: "view_mode" } } },
          ],
          detail: {
            header: [
              { type: "stack", props: { direction: "row", gap: "sm", align: "start" }, children: [field("name"), { type: "actions" }] },
            ],
            main: [field("count"), { type: "relations" }],
            side: [
              {
                type: "section",
                children: ["color", "min", "max", "step", "initial_count", "view_mode"].map(field),
              },
              { type: "section", children: [{ type: "properties" }] },
            ],
          },
        },
        open_while: { field: "count", below: { field: "max" } },
      },
    ],
    actions: [
      {
        id: "reset_all",
        name: { en: "Reset all" },
        on: "counter_group",
        confirm: { en: "Put every counter in this group back to its starting count?" },
        write: '{"items": {"counter": [items.counter.{"id": id, "set": {"count": initial_count}}]}}',
      },
    ],
  };
}

export function countersManifest(): Manifest {
  return {
    plugin_kind: "tool",
    features: ["tool"],
    default_name: "Counters",
    tool: countersTool(),
  };
}
