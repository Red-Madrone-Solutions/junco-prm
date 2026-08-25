export default {
  async fetch(): Promise<Response> {
    return new Response("junco-prm: transport not implemented until plan 2", { status: 501 });
  },
};
