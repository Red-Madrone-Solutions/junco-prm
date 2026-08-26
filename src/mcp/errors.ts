import { ToolError } from "../errors";

/**
 * The seven codes crossing the transport boundary.
 *
 * A FAILED TOOL CALL IS A RESULT, NOT A PROTOCOL ERROR, and the difference
 * matters more here than anywhere else in this plan.
 *
 * MCP separates "the server could not process this request" from "the tool ran
 * and refused." A `not_found` is the second kind: the model asked for a person
 * who does not exist, the server understood perfectly, and the useful answer is
 * "no such person, and here is the call that would work." Thrown as a JSON-RPC
 * error, that reaches the client as an exception the model cannot act on.
 * Returned as a result, the model reads the code and the corrective next call
 * and fixes itself.
 *
 * Plan 1 built `next` and `details` onto ToolError specifically so this could
 * work. Flattening them into a message string here would discard that at the
 * last possible step.
 */
export function toolErrorResult(e: ToolError): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  const body = e.toResult();
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  };
}

/**
 * Anything that is NOT a ToolError is a bug in this server, and it is reported
 * as one without leaking what it was.
 *
 * A raw exception message can carry a SQL fragment with a person's name in it,
 * which would put PRM content into a transcript and, through the log line the
 * caller writes, into an observability dashboard.
 */
/**
 * `internal` IS AN EIGHTH CODE, and Global Constraints say the set is closed at
 * seven. The exception is deliberate and is named here rather than left for a
 * reader to notice.
 *
 * The seven are the codes a CALLER can act on: every one names something the
 * agent did and implies a different next call. This one names something the
 * server did wrong, and there is no corrective call - which is exactly why it
 * cannot be folded into `invalid_input` or `conflict`, both of which would tell
 * the model to try something different when nothing different will help.
 *
 * It is distinguishable by shape as well as by name: no `next`, no `details`,
 * and a `request_id` no ToolError result carries. A client that binds to the
 * closed set can therefore tell it apart rather than mistaking it for one.
 */
export function unexpectedErrorResult(requestId: string): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: {
              code: "internal",
              reason: "the tool failed unexpectedly; the operator can find this in the logs",
              request_id: requestId,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}
