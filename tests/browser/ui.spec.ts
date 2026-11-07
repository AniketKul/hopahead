import { test, expect, type Page } from "@playwright/test";
import type {
  Advice,
  BoardResponse,
  JourneySettings,
  JourneyView,
  Prediction,
  ReplayScenario,
  SourceHealth,
} from "../../src/shared/contracts.js";

test.use({
  screenshot: "off",
  trace: "off",
  channel: process.env.HOPAHEAD_BROWSER_CHANNEL,
});
const now = new Date("2026-11-06T17:00:00Z");
const time = (seconds: number) =>
  new Date(now.getTime() + seconds * 1000).toISOString();
const source: SourceHealth = {
  observedAt: time(0),
  capturedAt: time(0),
  projectedAt: time(0),
  lastModified: time(0),
  generation: 1,
  revision: 1,
  topic: "predictions",
  partition: 0,
  offset: "4",
};
const settings: JourneySettings = {
  incomingTripId: "red-1",
  preferredOutgoingTripId: null,
  extraTransferSeconds: 0,
  boarded: false,
};
function prediction(
  id: string,
  tripId: string,
  routeId: string,
  stopId: string,
  sequence: number,
  seconds: number,
): Prediction {
  return {
    id,
    tripId,
    routeId,
    stopId,
    sequence,
    direction: 0,
    arrivalTime: time(seconds),
    departureTime: time(seconds),
    scheduleRelationship: null,
    status: null,
    arrivalUncertainty: null,
    departureUncertainty: null,
    serviceDate: "2026-11-06",
  };
}
const predictions = [
  prediction("red-harvard", "red-1", "Red", "70067", 1, 60),
  prediction("red-park", "red-1", "Red", "70075", 2, 300),
  prediction("green-park", "green-1", "Green-B", "70196", 1, 660),
  prediction("green-copley", "green-1", "Green-B", "70155", 2, 900),
];
const transfers = {
  version: "gtfs-test",
  source: "https://cdn.mbta.com/MBTA_GTFS.zip",
  importedAt: time(0),
  minima: { "70196": 152, "70197": 184, "70198": 152, "70199": 184 },
};
const advice: Advice = {
  status: "enough_time",
  headline: "Your connection has breathing room",
  explanation: "There is time beyond your transfer allowance.",
  incoming: predictions[1],
  incomingDeparture: predictions[0],
  source,
  evaluatedAt: time(0),
  ruleVersion: "test-v1",
  transferVersion: "gtfs-test",
  alerts: [],
  selected: {
    tripId: "green-1",
    routeId: "Green-B",
    departureTime: time(660),
    arrivalTime: time(900),
    transferSeconds: 152,
    marginSeconds: 208,
    status: "enough_time",
    explanation: "3 minutes 28 seconds beyond the planning allowance.",
    predictions: predictions.slice(2),
  },
  alternatives: [],
};
const journey: JourneyView = {
  id: "journey-test",
  revision: 4,
  settings,
  advice,
  updatedAt: time(0),
  history: [],
};
const scenario: ReplayScenario = {
  id: "delay",
  name: "Incoming train delayed",
  description: "A simulated delay changes the connection.",
  frames: [
    {
      label: "Before the delay",
      input: {
        transit: {
          predictions,
          alerts: [],
          predictionHealth: source,
          alertHealth: source,
        },
        settings,
        transfers,
        evaluatedAt: time(0),
      },
    },
    {
      label: "After the delay",
      input: {
        transit: {
          predictions: predictions.map((p) =>
            p.id === "red-park" ? { ...p, arrivalTime: time(600) } : p,
          ),
          alerts: [],
          predictionHealth: source,
          alertHealth: source,
        },
        settings,
        transfers,
        evaluatedAt: time(10),
      },
    },
  ],
};

async function fixture(
  page: Page,
  existing: boolean | JourneyView = false,
  events?: (JourneyView | null)[],
) {
  await page.clock.install({ time: now });
  let current: JourneyView | null = existing
    ? structuredClone(typeof existing === "object" ? existing : journey)
    : null;
  const commands: JourneySettings[] = [];
  await page.route("**/api/board", (route) =>
    route.fulfill({
      json: {
        incoming: [
          { tripId: "red-1", departureTime: time(60), arrivalTime: time(300) },
        ],
        source,
        serverTime: time(0),
        transfers,
        journey: current,
      } satisfies BoardResponse,
    }),
  );
  await page.route("**/api/journey", async (route) => {
    if (route.request().method() === "POST") {
      commands.push(route.request().postDataJSON());
      current = {
        ...journey,
        settings: commands.at(-1)!,
        revision: (current?.revision ?? 0) + 1,
      };
    } else if (route.request().method() === "DELETE") current = null;
    await route.fulfill({ json: current });
  });
  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body:
        (events ?? [])
          .map((item) => `event: journey\ndata: ${JSON.stringify(item)}\n\n`)
          .join("") || ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/replay", (route) =>
    route.fulfill({ json: [scenario] }),
  );
  await page.goto(process.env.HOPAHEAD_UI_URL ?? "/");
  return commands;
}

test("keyboard journey setup saves the pinned train and personal allowance", async ({
  page,
}) => {
  const commands = await fixture(page);
  await expect(
    page.getByRole("heading", {
      name: "Your next connection, one step ahead.",
    }),
  ).toBeVisible();
  await page.getByLabel("Your Red Line departure").selectOption("red-1");
  await page.getByLabel("Extra transfer time").fill("2");
  await page.getByRole("button", { name: "Watch this connection" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: advice.headline }),
  ).toBeVisible();
  expect(commands).toEqual([{ ...settings, extraTransferSeconds: 120 }]);
  await page
    .getByRole("button", { name: "I’m on this Red Line train" })
    .click();
  await expect.poll(() => commands.at(-1)?.boarded).toBe(true);
});

test("older streamed revisions cannot overwrite the latest advice", async ({
  page,
}) => {
  await fixture(page, true, [
    {
      ...journey,
      revision: 3,
      advice: { ...advice, headline: "Obsolete advice" },
    },
  ]);
  await expect(
    page.getByRole("heading", { name: advice.headline }),
  ).toBeVisible();
  await expect(page.getByText("Obsolete advice")).toHaveCount(0);
});

test("a watch stopped in another tab clears the local journey", async ({
  page,
}) => {
  await fixture(page, true, [null]);
  await expect(
    page.getByRole("button", { name: "Watch this connection" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop watching" })).toHaveCount(
    0,
  );
});

test("a preferred outgoing train can be returned to automatic selection", async ({
  page,
}) => {
  const commands = await fixture(page, {
    ...journey,
    settings: { ...settings, preferredOutgoingTripId: "green-1" },
  });
  await page
    .getByRole("button", { name: "Use best available connection" })
    .click();
  await expect.poll(() => commands.at(-1)?.preferredOutgoingTripId).toBe(null);
});

test("a frozen connection visibly ages into stale advice", async ({ page }) => {
  await fixture(page, true);
  await expect(
    page.getByRole("heading", { name: advice.headline }),
  ).toBeVisible();
  await page.clock.fastForward(95_000);
  await expect(
    page.getByRole("heading", { name: "Live predictions are stale" }),
  ).toBeVisible();
  await expect(page.getByText("Enough time", { exact: true })).toHaveCount(0);
});

test("replay scrubs and plays simulated frames without changing the live journey", async ({
  page,
}) => {
  const commands = await fixture(page);
  await page.getByRole("button", { name: "Replay lab" }).click();
  await expect(
    page.getByText("Simulated journey · never changes your live watch"),
  ).toBeVisible();
  await page.getByLabel("Replay position").focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("heading", { name: "After the delay" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restart replay" }).click();
  await page.getByRole("button", { name: "Play replay" }).click();
  await expect(
    page.getByRole("button", { name: "Pause replay" }),
  ).toBeVisible();
  await page.clock.fastForward(1600);
  await expect(
    page.getByRole("heading", { name: "After the delay" }),
  ).toBeVisible();
  expect(commands).toHaveLength(0);
});

test("narrow screens keep setup and replay controls within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page);
  await expect(page.getByLabel("Your Red Line departure")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Replay lab" }).click();
  await expect(page.getByLabel("Replay position")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
