import { Module } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import { createAuth, type AuthInstance } from "./auth";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AUTH } from "./auth.tokens";

@Module({
  controllers: [AuthController],
  providers: [
    AuthGuard,
    {
      provide: AUTH,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): AuthInstance => createAuth(prisma),
    },
  ],
  exports: [AUTH, AuthGuard],
})
export class AuthModule {}
