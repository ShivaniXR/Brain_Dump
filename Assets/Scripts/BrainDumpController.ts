/**
 * Brain Dumpd — data-layer orchestrator (no 3D visuals yet).
 *
 * Flow:
 *   pinch (or tap in the editor) to START continuous transcription
 *   -> accumulate speech via the ASR module
 *   pinch/tap again to STOP
 *   -> send the transcript to the LLM service
 *   -> parse into typed Task objects
 *   -> print the tasks to the console
 *
 * Attach this component to one SceneObject. The ASR and Gesture modules are
 * acquired via require(), so no asset inputs need wiring. The LLM call lives in
 * LLMService (swap the TaskExtractor instance below to change providers).
 *
 * REQUIRED SCENE SETUP: a RemoteServiceGatewayCredentials component must exist in
 * the scene with your OpenAI token filled in, or the LLM call will fail to auth.
 */
import { TaskExtractor, OpenAITaskExtractor } from "./LLMService";
import { Task } from "./TaskTypes";

// Brief pauses are normal in a brain dump, so tolerate a long silence before the
// ASR segment is finalized. Tune down if end-of-speech should be snappier.
const SILENCE_TERMINATION_MS = 3000;

@component
export class BrainDumpController extends BaseScriptComponent {
  // Swap point: assign any TaskExtractor implementation to change LLM provider.
  private extractor: TaskExtractor = new OpenAITaskExtractor();

  private asr = require("LensStudio:AsrModule") as AsrModule;
  private gestureModule = require("LensStudio:GestureModule") as GestureModule;

  private options: AsrModule.AsrTranscriptionOptions;
  private isListening = false;

  // Transcript accumulation: finalized segments + the latest in-flight interim.
  private finalizedText = "";
  private currentInterim = "";

  onAwake(): void {
    this.setupAsrOptions();
    this.bindTrigger();
    print("[BrainDumpd] Ready. Pinch (or tap in editor) to start/stop a brain dump.");
  }

  private setupAsrOptions(): void {
    const options = AsrModule.AsrTranscriptionOptions.create();
    options.mode = AsrModule.AsrMode.HighAccuracy;
    options.silenceUntilTerminationMs = SILENCE_TERMINATION_MS;

    options.onTranscriptionUpdateEvent.add((evt: AsrModule.TranscriptionUpdateEvent) => {
      if (evt.isFinal) {
        if (evt.text) {
          this.finalizedText = (this.finalizedText + " " + evt.text).trim();
        }
        this.currentInterim = "";
      } else {
        this.currentInterim = evt.text || "";
      }
      print("[BrainDumpd] Listening: " + this.combinedTranscript());
    });

    options.onTranscriptionErrorEvent.add((statusCode: AsrModule.AsrStatusCode) => {
      print("[BrainDumpd] ASR error, status code: " + statusCode);
    });

    this.options = options;
  }

  private bindTrigger(): void {
    if (global.deviceInfoSystem.isEditor()) {
      // No hand tracking in the editor — use tap to toggle.
      this.createEvent("TapEvent").bind(() => this.toggle());
    } else {
      // Right-hand pinch. Numeric literal cast: the runtime enum isn't exposed as a value.
      const rightHand = 1 as unknown as GestureModule.HandType;
      this.gestureModule.getPinchDownEvent(rightHand).add(() => this.toggle());
    }
  }

  private toggle(): void {
    if (this.isListening) {
      this.stop();
    } else {
      this.start();
    }
  }

  private start(): void {
    this.finalizedText = "";
    this.currentInterim = "";
    this.isListening = true;
    this.asr.startTranscribing(this.options);
    print("[BrainDumpd] ▶ Listening started. Speak your brain dump, then pinch/tap to stop.");
  }

  private stop(): void {
    this.isListening = false;
    this.asr.stopTranscribing();
    const transcript = this.combinedTranscript();
    print("[BrainDumpd] ■ Listening stopped.");
    this.processTranscript(transcript);
  }

  private combinedTranscript(): string {
    return (this.finalizedText + " " + this.currentInterim).trim();
  }

  private processTranscript(transcript: string): void {
    if (!transcript) {
      print("[BrainDumpd] Empty transcript — nothing to parse.");
      return;
    }
    print("[BrainDumpd] Transcript: " + transcript);
    print("[BrainDumpd] Sending to LLM...");

    this.extractor
      .extractTasks(transcript)
      .then((tasks) => this.printTasks(tasks))
      .catch((error) => print("[BrainDumpd] LLM error: " + error));
  }

  private printTasks(tasks: Task[]): void {
    print("[BrainDumpd] Parsed " + tasks.length + " task(s):");
    if (tasks.length === 0) {
      print("[BrainDumpd]   (no actionable tasks found)");
      return;
    }
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      print(
        "[BrainDumpd]   " +
          (i + 1) +
          ". [" +
          t.urgency +
          "/" +
          t.category +
          "] " +
          t.title
      );
    }
  }
}
