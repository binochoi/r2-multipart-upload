import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  // shared(순수 타입/상수)·server(S3 서명·멀티파트 관리)·client(재개형 엔진)를 각각
  // 별도 엔트리로 번들한다. aws4fetch 는 server.mts 만 쓰므로 그 번들에만 인라인된다.
  entries: [{ type: "bundle", input: ["src/shared.mts", "src/server.mts", "src/client.mts"] }],
});
