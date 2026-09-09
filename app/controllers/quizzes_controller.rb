# The quiz editor's API. Quizzes belong to the signed-in instructor.
class QuizzesController < InstructorController
  BAD_ID = "Use letters, digits, dash or underscore for the file name".freeze

  def index
    render json: current_user.quizzes.ordered.map(&:summary)
  end

  def show
    quiz = find_quiz or return
    render json: quiz.body
  end

  def update
    return render json: { error: BAD_ID }, status: :bad_request unless params[:id].to_s.match?(Quiz::SLUG)

    body = json_body
    problems = Tigerquiz::QuizDocument.validate(body)["problems"]
    return render json: { error: "Fix these first", problems: problems }, status: :bad_request if problems.any?

    # only known fields are kept, so a stray key cannot end up in the document
    clean = Tigerquiz::QuizDocument.pick_fields(body)
    quiz = current_user.quizzes.find_or_initialize_by(slug: params[:id])
    quiz.body = clean
    quiz.save!
    render json: { ok: true, id: quiz.slug, count: clean["questions"].length }
  end

  def destroy
    quiz = find_quiz or return
    quiz.destroy!
    render json: { ok: true }
  end

  # Check a draft without saving it, so the editor can show problems as you type.
  def check
    result = Tigerquiz::QuizDocument.validate(json_body)
    render json: { ok: result["problems"].empty?, problems: result["problems"], count: result["questions"]&.length || 0 }
  end

  private

  # The quiz named in the URL, or nil after rendering the error for it.
  def find_quiz
    unless params[:id].to_s.match?(Quiz::SLUG)
      render json: { error: "bad quiz id" }, status: :bad_request
      return nil
    end
    quiz = current_user.quizzes.find_by(slug: params[:id])
    render json: { error: "No such quiz" }, status: :not_found unless quiz
    quiz
  end
end
