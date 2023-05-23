import { RoleAction, ai, RoleTemplateFunction, gen, map } from "./actions";
import { PromiseOrCursor, generatorOrPromise } from "../generatorOrPromise";
import {
  chatGPT3Completion,
  chatGPT4Completion,
  davinciCompletion,
} from "../llmConnectors";
import { PromptElement, PromptStorage } from "../PromptStorage";
import {
  Action,
  Outputs,
  State,
  TemplateAction,
  TemplateActionInput,
  runActions,
} from "./primitives";

export type AnyObject = Record<string, any>;

export type LLMCompletionFn = (props: {
  prompt: PromptStorage;
  stop?: string;
}) => PromiseOrCursor<string, string>;

type GenFunc<T> = (name: T, stop?: string) => Action<any>;
type MapFunc<T> = <Parameters = any>(
  name: T,
  elements: TemplateActionInput<Parameters>[]
) => Action<Parameters>;

// type
type SubTypeKeysOnly<O extends Outputs> = {
  [K in keyof O]: O[K] extends Outputs[] ? K : unknown;
}[keyof O];

type NonObjectKeys<T> = {
  [K in keyof T]: T[K] extends string | string[] ? K : never;
}[keyof T];

type ArrayElementType<T> = T extends (infer E)[] ? E : never;

type RecursiveNonObjectKeys<T> = T extends string | string[]
  ? never
  : T extends any[]
  ? RecursiveNonObjectKeys<ArrayElementType<T>>
  :
      | {
          [K in keyof T]: RecursiveNonObjectKeys<T[K]>;
        }[keyof T]
      | NonObjectKeys<T>;

type ActionFuncs<O extends Outputs> = {
  gen: GenFunc<RecursiveNonObjectKeys<O>>;
  map: MapFunc<SubTypeKeysOnly<O>>;
};

// type GenFunc = Exclude<Parameters<typeof gen>>;

export type LLMPromptFunction<Parameters, O extends Outputs> = (
  props: {
    ai: TemplateAction<Parameters>;
    params: Parameters;
  } & ActionFuncs<O>
) => ReturnType<TemplateAction<Parameters>>;

type LLMPromptArrayFunction<Parameters, O extends Outputs> = (
  props: {
    ai: TemplateAction<Parameters>;
    params: Parameters;
  } & ActionFuncs<O>
) => (RoleAction<Parameters>[][] | RoleAction<Parameters>)[];

// const

type CreateCompletionFunc = (props: {
  prompt: PromptStorage;
  stop?: string;
}) => Promise<NodeJS.ReadableStream>;

export const createModelCompletion = (
  func: CreateCompletionFunc
): LLMCompletionFn => {
  const returnFunc = (props: { prompt: PromptStorage; stop?: string }) => {
    async function* generator() {
      let fullString = "";

      const stream = await func(props);

      for await (const chunk of stream) {
        fullString += chunk.toString();
        yield chunk.toString();
      }

      return fullString;
    }

    return generatorOrPromise(generator());
  };

  return returnFunc;
};

const llmFactory = (completion: LLMCompletionFn) => {
  function llm<
    Parameters extends AnyObject | undefined = any,
    O extends Outputs = Outputs
  >(props: LLMPromptFunction<Parameters, O>) {
    return (params: Parameters) => {
      const prompt = new PromptStorage(false);
      const outputs = {} as O;

      async function* generator() {
        const generator = props({
          ai: ai as unknown as TemplateAction<Parameters>,
          params,
          ...typedActionFuncs<O>(),
        })({
          completion: completion,
          outputs,
          context: { role: "none", outputAddress: [] },
          params,
          currentPrompt: prompt,
          nextString: undefined,
          state: { loops: {}, queue: {} },
        });

        for await (const value of generator.generator) {
          prompt.pushElement(value);
          yield { ...value, prompt, outputs };
        }

        return { prompt, outputs };
      }

      return generatorOrPromise(generator());
    };
  }

  return llm;
};

function chatGptFactory(llmFunction: LLMCompletionFn) {
  return function <
    Parameters extends AnyObject = any,
    O extends Outputs = Outputs
  >(
    messages:
      | (RoleAction<Parameters> | RoleAction<Parameters>[][])[]
      | LLMPromptArrayFunction<Parameters, O>
  ) {
    return (parameters: Parameters) => {
      const prompt = new PromptStorage();
      const outputs = {} as O;
      const _messages =
        typeof messages === "function"
          ? messages({
              ai: ai as unknown as TemplateAction<Parameters>,
              params: parameters,
              ...typedActionFuncs<O>(),
            })
          : messages;

      const state: State = {
        loops: {},
        queue: {},
      };
      async function* generator() {
        for (let i = 0; i < _messages.length; i++) {
          const generator = runActions(_messages[i], {
            completion: llmFunction,
            outputs,
            params: parameters,
            currentPrompt: prompt,
            context: { role: "none", outputAddress: [] },
            nextString: undefined,
            state,
          });

          for await (const value of generator) {
            prompt.pushElement(value);
            yield { ...value, prompt, outputs };
          }
        }
        return { prompt, outputs };
      }

      function input(name: string, value: any) {
        if (!state.queue[name]) state.queue[name] = [];
        state.queue[name].push(value);
      }

      // onNewOputput

      return generatorOrPromise(generator(), { input });
    };
  };
}

export const gpt3 = chatGptFactory(chatGPT3Completion);
export const gpt4 = chatGptFactory(chatGPT4Completion);

export const typedActionFuncs = <O extends Outputs>(): ActionFuncs<O> => {
  return {
    gen: gen as unknown as GenFunc<RecursiveNonObjectKeys<O>>,
    map: map as unknown as MapFunc<SubTypeKeysOnly<O>>,
  };
};

export function davinci<
  Parameters extends AnyObject | undefined = any,
  O extends Outputs = Outputs
>(props: LLMPromptFunction<Parameters, O>) {
  return (params: Parameters) => {
    const prompt = new PromptStorage(false);
    const outputs = {} as O;

    async function* generator() {
      const generator = props({
        ai: ai as unknown as TemplateAction<Parameters>,
        params,
        ...typedActionFuncs<O>(),
      })({
        completion: davinciCompletion,
        outputs,
        context: { role: "none", outputAddress: [] },
        params,
        currentPrompt: prompt,
        nextString: undefined,
        state: { loops: {}, queue: {} },
      });

      for await (const value of generator.generator) {
        prompt.pushElement(value);
        yield { ...value, prompt, outputs };
      }

      return { prompt, outputs };
    }

    return generatorOrPromise(generator());
  };
}

export const createCompletion = (func: CreateCompletionFunc) => {
  return llmFactory(createModelCompletion(func));
};

export const createChatCompletion = (func: CreateCompletionFunc) => {
  return chatGptFactory(createModelCompletion(func));
};
