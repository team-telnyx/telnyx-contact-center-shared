import { LoginForm } from "@/components/login-form";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { redirect } from "next/navigation";
import { AuthBrandLogo } from "@/components/auth-brand-logo";
import { AuthRightImage } from "@/components/auth-right-image";

export default async function SigninPage({ searchParams }) {
  const session = await getServerSession(authOptions);
  if (session?.user) redirect("/");

  const params = await searchParams;
  if (params?.username || params?.password) {
    const cleanParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === "username" || key === "password") continue;
      if (Array.isArray(value)) {
        value.forEach((item) => cleanParams.append(key, item));
      } else if (value != null) {
        cleanParams.set(key, value);
      }
    }
    const query = cleanParams.toString();
    redirect(query ? `/signin?${query}` : "/signin");
  }

  return (
    <div className="dark grid min-h-svh lg:grid-cols-[1fr_1.8fr] bg-background text-foreground">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <div className="flex justify-center w-full">
            <div className="flex flex-col items-center w-full justify-center">
              <AuthBrandLogo />
              <span className="text-6xl font-bold mt-10 text-brand-primary dark:text-brand-primary">
                Contact Center
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-1 mt-30 justify-center">
          <div className="w-full max-w-xs">
            <LoginForm />
          </div>
        </div>
      </div>
      <div className="bg-muted relative hidden lg:block m-5 rounded-xl overflow-hidden">
        <AuthRightImage />
      </div>
    </div>
  );
}
