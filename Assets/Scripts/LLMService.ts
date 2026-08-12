/**
 * Brain Dumpd — LLM service.
 *
 * Provider-agnostic interface + an OpenAI implementation (locked: gpt-4o-mini via
 * Remote Service Gateway, using Structured Outputs). To swap providers later,
 * implement TaskExtractor and hand a different instance to the controller — nothing
 * else in the app needs to change.
 */
import { OpenAI } from "RemoteServiceGateway.lspkg/HostedExternal/OpenAI";
import { OpenAITypes } from "RemoteServiceGateway.lspkg/HostedExternal/OpenAITypes";
import { Task } from "./TaskTypes";
import { extractTasksWithFallback, LLMCall } from "./TaskParsing";

/** Hard cap on the LLM round-trip before we fall back locally. */
const LLM_TIMEOUT_MS = 8000;

/** The only surface the rest of the app depends on. */
export interface TaskExtractor {
  /** Turn a raw spoken transcript into a list of typed tasks. */
  extractTasks(transcript: string): Promise<Task[]>;
}

const SYSTEM_PROMPT =
  "You convert a person's spoken stream-of-consciousness brain dump into a concise task list. " +
  "Extract each DISTINCT actionable task the person mentions. For each task:\n" +
  "- title: an imperative phrase, MAXIMUM 6 words, no filler words.\n" +
  "- urgency: 'now' (urgent / must do today / they sound stressed about it), " +
  "'next' (soon, this week), or 'later' (someday / low priority).\n" +
  "- category: 'work', 'home', or 'errand'.\n" +
  "If the text contains no actionable tasks, return an empty tasks array. " +
  "Do not invent tasks that were not mentioned.";

/** JSON Schema for Structured Outputs. Root must be an object, so tasks are nested. */
const TASK_LIST_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Imperative phrase, max 6 words" },
          urgency: { type: "string", enum: ["now", "next", "later"] },
          category: { type: "string", enum: ["work", "home", "errand"] },
        },
        required: ["title", "urgency", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

export class OpenAITaskExtractor implements TaskExtractor {
  private readonly model: string;

  constructor(model: string = "gpt-4o-mini") {
    this.model = model;
  }

  /** Raw transport: send the transcript, resolve with the model's text content. */
  private callOpenAI: LLMCall = (transcript: string) => {
    const request: OpenAITypes.ChatCompletions.Request = {
      model: this.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "task_list",
          strict: true,
          schema: TASK_LIST_SCHEMA,
        },
      },
    };
    return OpenAI.chatCompletions(request).then((response) =>
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : ""
    );
  };

  extractTasks(transcript: string): Promise<Task[]> {
    // Hardened path: LLM under an 8s cap, else a local fallback parse. Never rejects.
    return extractTasksWithFallback(transcript, this.callOpenAI, LLM_TIMEOUT_MS).then(
      (result) => {
        if (result.source === "fallback") {
          print("[LLMService] LLM path failed (" + result.reason + ") — used local fallback parser.");
        }
        return result.tasks;
      }
    );
  }
}
