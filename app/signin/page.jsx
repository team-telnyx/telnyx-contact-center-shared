import { LoginForm } from "@/components/login-form";
import Image from "next/image";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { redirect } from "next/navigation";

export default async function SigninPage() {
  const session = await getServerSession(authOptions);
  if (session?.user) redirect("/");
  return (
    <div className="dark grid min-h-svh lg:grid-cols-[1fr_1.8fr] bg-background text-foreground">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <div className="flex justify-center w-full">
            <div className="flex flex-col items-center w-full justify-center">
              <Image
                src="/telnyx_green_transparent.png"
                alt="Telnyx LLC"
                width={400}
                height={50}
                style={{ width: "auto", height: "auto" }}
                priority
                className="brightness-0 dark:invert"
              />
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
        <Image
          src="/cc_space.jpg"
          alt="Contact Center"
          className="absolute inset-0 h-full w-full object-cover grayscale"
          width={1000}
          height={1000}
          style={{ width: "100%", height: "100%" }}
          priority
        />
      </div>
    </div>
  );
}
