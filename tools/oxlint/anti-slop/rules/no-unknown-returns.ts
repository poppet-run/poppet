import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { functionVisitors, type FunctionLike } from "../shared/function-parameters.ts";
import {
  createTypeAliasEnvironment,
  resolvesToUnknown,
  type TypeAliasEnvironment,
} from "../shared/type-alias-resolution.ts";

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    let environment: TypeAliasEnvironment | null = null;

    const returnsUnknown = (type: ESTree.TSType): boolean =>
      environment !== null && resolvesToUnknown(type, environment, true);

    const checkReturnType = (node: FunctionLike) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!returnsUnknown(annotation.typeAnnotation)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        environment = createTypeAliasEnvironment(
          node,
          context.sourceCode.visitorKeys,
        );
      },
      ...functionVisitors(checkReturnType),
    };
  },
});
