// Browser-fixture shim for next/navigation: pages render outside the Next.js router.
export function useRouter(){return {push(){},replace(){},refresh(){},back(){},prefetch(){}};}
export function usePathname(){return typeof window==='undefined'?'/':window.location.pathname;}
export function useSearchParams(){return new URLSearchParams(typeof window==='undefined'?'':window.location.search);}
export function useParams(){return {};}
export function redirect(){}
export function notFound(){}
