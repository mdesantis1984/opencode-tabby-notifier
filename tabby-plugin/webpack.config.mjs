import { builtinModules } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url))
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
const hostModule = /^(?:@angular(?:\/|$)|@ng-bootstrap(?:\/|$)|rxjs(?:\/|$)|tabby-[^/]+(?:\/|$)|ngx-toastr(?:\/|$))/

export default {
  mode: "production",
  target: "node18",
  entry: path.join(pluginDirectory, "src/index.ts"),
  output: {
    path: path.join(pluginDirectory, "dist"),
    filename: "index.js",
    library: { type: "umd" },
    globalObject: "globalThis",
  },
  devtool: false,
  externalsType: "commonjs",
  externals: [
    ({ request }, callback) => {
      if (request && (builtins.has(request) || hostModule.test(request))) {
        callback(null, request)
        return
      }
      callback()
    },
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: "ts-loader",
          options: {
            compiler: "typescript-for-ts-loader",
            configFile: path.join(pluginDirectory, "tsconfig.build.json"),
            transpileOnly: true,
          },
        },
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  optimization: {
    minimize: false,
    runtimeChunk: false,
    splitChunks: false,
  },
  performance: false,
}
