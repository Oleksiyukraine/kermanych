/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

// iOS Safari's own flag: true when the page runs as a home-screen web app.
interface Navigator {
  standalone?: boolean;
}
