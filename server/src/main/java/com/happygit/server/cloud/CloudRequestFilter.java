package com.happygit.server.cloud;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.*;

/** Bound the actual decoded request stream, including chunked transfer bodies. */
@Component @Profile("cloud")
public class CloudRequestFilter extends OncePerRequestFilter {
    @Override protected boolean shouldNotFilter(HttpServletRequest request) { return !request.getRequestURI().startsWith("/api/v2/"); }
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
        response.setHeader("Cache-Control","no-store"); response.setHeader("X-Content-Type-Options","nosniff");
        if (request.getHeader("Content-Encoding")!=null && !request.getHeader("Content-Encoding").equals("identity")) { response.sendError(415);return; }
        byte[] bytes=request.getInputStream().readNBytes(1048577);
        if(bytes.length>1048576) { response.setStatus(413);response.setContentType("application/json");response.getWriter().write("{\"code\":\"BODY_TOO_LARGE\",\"message\":\"请求体上限为 1 MiB\"}");return; }
        HttpServletRequestWrapper wrapped=new HttpServletRequestWrapper(request) {
            @Override public ServletInputStream getInputStream() {
                ByteArrayInputStream input=new ByteArrayInputStream(bytes);
                return new ServletInputStream() {
                    public int read() {return input.read();} public boolean isFinished(){return input.available()==0;} public boolean isReady(){return true;}
                    public void setReadListener(ReadListener listener){throw new UnsupportedOperationException("Synchronous JSON endpoint");}
                };
            }
            @Override public BufferedReader getReader(){return new BufferedReader(new InputStreamReader(getInputStream(),java.nio.charset.StandardCharsets.UTF_8));}
        };
        chain.doFilter(wrapped,response);
    }
}
