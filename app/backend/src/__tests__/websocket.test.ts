/**
 * Unit tests for the WebSocket server
 */
import { broadcast, getWsStats } from "../websocket";

// Mock dependencies
jest.mock("../utils/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("jsonwebtoken", () => ({
  decode: jest.fn(),
  verify: jest.fn(),
}));

jest.mock("jwks-rsa", () => {
  return jest.fn().mockReturnValue({
    getSigningKey: jest.fn(),
  });
});

describe("WebSocket module exports", () => {
  describe("broadcast", () => {
    it("should be a function", () => {
      expect(typeof broadcast).toBe("function");
    });

    it("should not throw when broadcasting to a channel with no subscribers", () => {
      expect(() => broadcast("test-channel", "test-event", { data: "test" })).not.toThrow();
    });
  });

  describe("getWsStats", () => {
    it("should return stats object with correct shape", () => {
      const stats = getWsStats();
      expect(stats).toHaveProperty("totalClients");
      expect(stats).toHaveProperty("totalChannels");
      expect(stats).toHaveProperty("channels");
      expect(typeof stats.totalClients).toBe("number");
      expect(typeof stats.totalChannels).toBe("number");
    });

    it("should return zero clients and channels initially", () => {
      const stats = getWsStats();
      expect(stats.totalClients).toBe(0);
      expect(stats.totalChannels).toBe(0);
    });
  });
});
