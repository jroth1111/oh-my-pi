import { beforeAll, describe, expect, it } from "bun:test";
import { extensionEventFromSessionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import { TodoReminderComponent } from "@oh-my-pi/pi-tui/chat/todo-reminder";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const nativeContext: DescribeContext = {
	cols: 100,
	reduceMotion: true,
	dark: true,
	supports: kind => kind === "checklist",
	feature: () => false,
};

beforeAll(async () => {
	await initTheme(false);
});

describe("unverified merge reminder presentation", () => {
	it("renders the pending parent check when there are no unfinished todos", () => {
		const reminder = new TodoReminderComponent([], 1, 3, true);
		const rendered = Bun.stripANSI(reminder.render(100).join("\n"));
		expect(rendered).toContain("merged changes need verification");
		expect(rendered).toContain("run the parent verification");
		expect(rendered).not.toContain("0 incomplete");
	});

	it("retains that instruction on a checklist-capable native surface", () => {
		const reminder = new TodoReminderComponent([], 1, 3, true);
		const native = reminder.describe(nativeContext);
		expect(native.k).not.toBe("checklist");
		const encoded = JSON.stringify(native);
		expect(encoded).toContain("merged changes need verification");
		expect(encoded).toContain("run the parent verification");
	});

	it("labels outstanding todos and their unverified merge together", () => {
		const reminder = new TodoReminderComponent([{ content: "Finish tests", status: "pending" }], 2, 3, true);
		const rendered = Bun.stripANSI(reminder.render(100).join("\n"));
		expect(rendered).toContain("1 incomplete todo + unverified merge");
		const native = reminder.describe(nativeContext);
		expect(native.k).toBe("checklist");
		if (native.k !== "checklist") throw new Error("Expected a native todo checklist");
		expect(native.p?.note).toContain("unverified merge");
		expect(native.p?.phases?.[0]?.items?.[0]?.text).toBe("Finish tests");
	});

	it("keeps an ordinary reminder free of a merge warning", () => {
		const reminder = new TodoReminderComponent([{ content: "Finish tests", status: "pending" }], 1, 3);
		const rendered = Bun.stripANSI(reminder.render(100).join("\n"));
		expect(rendered).toContain("1 incomplete todo");
		expect(rendered).not.toContain("unverified merge");
	});

	it("forwards the verified-needed flag through the current extension event mapper", () => {
		expect(
			extensionEventFromSessionEvent(
				{ type: "todo_reminder", todos: [], attempt: 1, maxAttempts: 3, unverifiedMerge: true },
				0,
			),
		).toEqual({ type: "todo_reminder", todos: [], attempt: 1, maxAttempts: 3, unverifiedMerge: true });
	});
});
