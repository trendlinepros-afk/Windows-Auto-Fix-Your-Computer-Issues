const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const common = (mode) => ({
  mode: mode || 'production',
  devtool: mode === 'development' ? 'source-map' : false,
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: { transpileOnly: false },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  node: {
    __dirname: false,
    __filename: false,
  },
});

module.exports = (env, argv) => {
  const mode = (argv && argv.mode) || 'production';

  const mainConfig = {
    ...common(mode),
    name: 'main',
    target: 'electron-main',
    entry: path.resolve(__dirname, 'src/main/index.ts'),
    output: {
      path: path.resolve(__dirname, 'dist/main'),
      filename: 'index.js',
    },
    externals: {
      electron: 'commonjs2 electron',
    },
  };

  const preloadConfig = {
    ...common(mode),
    name: 'preload',
    target: 'electron-preload',
    entry: path.resolve(__dirname, 'src/preload/preload.ts'),
    output: {
      path: path.resolve(__dirname, 'dist/preload'),
      filename: 'preload.js',
    },
    externals: {
      electron: 'commonjs2 electron',
    },
  };

  const rendererConfig = {
    ...common(mode),
    name: 'renderer',
    target: 'web',
    entry: path.resolve(__dirname, 'src/renderer/index.tsx'),
    output: {
      path: path.resolve(__dirname, 'dist/renderer'),
      filename: 'renderer.js',
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public/index.html'),
        title: 'Windows Troubleshooter',
      }),
    ],
  };

  return [mainConfig, preloadConfig, rendererConfig];
};
