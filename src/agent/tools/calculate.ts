/** calculate: exact arithmetic, percentages and time math through the safe evaluator in calc.ts. */
import { requiredText } from './args';
import { evaluate } from './calc';
import { makeTool } from './define';

export const calculateTools = [
  makeTool<{ expression: string }>({
    name: 'calculate',
    description:
      'Evaluates a math expression exactly instead of doing arithmetic in your head. Supports + - * / ^ mod, '
      + 'parentheses, n!, percentages ("15% of 80", "80 + 15%", "80 - 15%"), functions (sqrt, round(x, digits), '
      + 'log, ln, sin/cos/tan in radians, deg/rad, min, max, sum, avg, pow, hypot), constants (pi, e) and time math '
      + '("2h 30m + 45 min", "17:30 - 09:15", "3 days in hours", "90 min to hours").',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'The expression, e.g. "(1200 - 15%) / 3".' } },
      required: ['expression'],
    },
    policy: 'auto',
    failure: "Couldn't calculate that",
    parse(args) {
      return { expression: requiredText(args, 'expression', 500) };
    },
    describe(args) {
      return `Calculate ${args.expression}`;
    },
    async run(args) {
      const result = evaluate(args.expression);
      return {
        ok: true,
        summary: `${args.expression} = ${result.display}`,
        data: {
          expression: args.expression,
          result: result.value,
          display: result.display,
          kind: result.kind,
          ...(result.unit ? { unit: result.unit } : {}),
          ...(result.seconds !== undefined && result.unit !== 'seconds' ? { seconds: result.seconds } : {}),
        },
      };
    },
  }),
];
