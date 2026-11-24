/*
 A script address under Trusted Types.

 With require-trusted-types-for 'script' the page refuses a plain string at
 every script sink: a script tag, a worker, an audio worklet module. The rule
 here is the rule of the page: the address is this origin, or a blob of this
 origin. A browser without Trusted Types gets the string back, so a call site
 reads the same in both modes.
*/

type ScriptURLPolicy = { createScriptURL(url: string): string };

type TrustedTypesFactory = {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): ScriptURLPolicy;
};

const factory = (window as unknown as { trustedTypes?: TrustedTypesFactory }).trustedTypes;

const policy = factory
  ? factory.createPolicy('stanze', {
      createScriptURL(url) {
        let parsed: URL;
        try {
          parsed = new URL(url, location.href);
        } catch {
          throw new TypeError('script url refused: ' + url);
        }
        if (parsed.origin !== location.origin) throw new TypeError('script url refused: ' + url);
        return url;
      },
    })
  : null;

// scriptURL marks the address of a script, a worker or an audio worklet module.
export function scriptURL(url) {
  return policy ? policy.createScriptURL(url) : url;
}
