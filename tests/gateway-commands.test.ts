import { describe, expect, it } from "vitest";
import {
  parseGatewayCommand,
  selectModel,
  streamMenu,
} from "../src/gateway/commands.js";

const astra = {
  model: "gpt-6-astra",
  displayName: "Astra",
  supportedReasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "high",
  isDefault: true,
};

describe("secretary commands", () => {
  it("recognizes sent full-width slash commands and keeps ordinary mixed prose intact", () => {
    expect(parseGatewayCommand("  ／model astra low  ")).toEqual({
      type: "model",
      args: ["astra", "low"],
    });
    expect(parseGatewayCommand("请说明 /model 怎么用")).toBeNull();
    expect(parseGatewayCommand("/newchat and delete files")).toMatchObject({
      type: "unknown",
    });
  });
  it("uses the catalog default and rejects unsupported or ambiguous choices", () => {
    expect(selectModel(["astra"], [astra])).toEqual({
      selection: { model: astra.model, effort: "high" },
    });
    expect(selectModel(["ASTRA", "LOW"], [astra])).toEqual({
      selection: { model: astra.model, effort: "low" },
    });
    expect(selectModel(["astra", "ultra"], [astra])).toHaveProperty("error");
    expect(selectModel(["invented", "low"], [astra])).toHaveProperty("error");
    const choices = [astra, { ...astra, model: "gpt-7-astra" }];
    expect(selectModel(["astra", "low"], choices)).toHaveProperty("error");
    expect(selectModel(["gpt-6-astra", "low"], choices)).toHaveProperty(
      "selection",
    );
    expect(selectModel(["astra", "low", "extra"], [astra])).toHaveProperty(
      "error",
    );
  });
  it("parses stream mode commands and shows the saved mode with exact toggles", () => {
    expect(parseGatewayCommand("/stream")).toEqual({
      type: "stream",
      args: [],
    });
    expect(parseGatewayCommand("／stream off")).toEqual({
      type: "stream",
      args: ["off"],
    });
    expect(streamMenu(true)).toContain("当前流式发送：开启");
    expect(streamMenu(false)).toContain(
      "/stream off：等每条完整回复生成后再发送，下一次回复生效",
    );
  });
});
